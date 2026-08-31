package runtime

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/config"
	"github.com/sianachi/Nix/apps/go-workers/internal/exportjob"
	"github.com/sianachi/Nix/apps/go-workers/internal/httpserver"
	"github.com/sianachi/Nix/apps/go-workers/internal/importer"
	"github.com/sianachi/Nix/apps/go-workers/internal/importjob"
	"github.com/sianachi/Nix/apps/go-workers/internal/index"
	"github.com/sianachi/Nix/apps/go-workers/internal/indexer"
	"github.com/sianachi/Nix/apps/go-workers/internal/jobrunner"
	"github.com/sianachi/Nix/apps/go-workers/internal/objecttransfer"
	"github.com/sianachi/Nix/apps/go-workers/internal/opensearch"
	"github.com/sianachi/Nix/apps/go-workers/internal/role"
	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
)

func Run(service role.Service) {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	settings, err := config.Load(os.Getenv)
	if err != nil {
		logger.Error("invalid configuration", "error", err)
		os.Exit(1)
	}
	if len(os.Args) == 2 && os.Args[1] == "--healthcheck" {
		response, healthErr := http.Get("http://127.0.0.1" + settings.Address + "/healthz")
		if healthErr != nil || response.StatusCode != http.StatusOK {
			if response != nil {
				_ = response.Body.Close()
			}
			os.Exit(1)
		}
		_ = response.Body.Close()
		return
	}

	searchIndex := index.New(settings.MaxTokens, settings.MaxRecords)
	var ready atomic.Bool
	ready.Store(settings.InternalAPIURL == "")
	server := httpserver.NewForRole(service, httpserver.Dependencies{
		Logger:         logger,
		InternalSecret: settings.InternalSecret,
		MaxInputSize:   settings.MaxInputBytes,
		MaxRecords:     settings.MaxRecords,
		MaxLineBytes:   settings.MaxLineBytes,
		MaxTokens:      settings.MaxTokens,
		RequestTimeout: settings.RequestTimeout,
		Index:          searchIndex,
		Ready:          ready.Load,
	})
	httpServer := &http.Server{
		Addr:              settings.Address,
		Handler:           server,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       settings.RequestTimeout,
		WriteTimeout:      settings.RequestTimeout,
		IdleTimeout:       30 * time.Second,
		MaxHeaderBytes:    16 * 1024,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if settings.InternalAPIURL != "" {
		apiProbe := workerapi.New(settings.InternalAPIURL, settings.InternalSecret, settings.WorkerID, settings.RequestTimeout)
		var searchProbe *opensearch.Client
		if service == role.Index && settings.OpenSearchURL != "" {
			searchProbe = opensearch.New(settings.OpenSearchURL, settings.OpenSearchIndex, settings.RequestTimeout)
		}
		go probeReadiness(ctx, apiProbe, searchProbe, &ready, settings.PollInterval, logger)
	}
	if service == role.Index && settings.InternalAPIURL != "" {
		client := workerapi.New(settings.InternalAPIURL, settings.InternalSecret, settings.WorkerID, settings.RequestTimeout)
		var searchClient *opensearch.Client
		if settings.OpenSearchURL != "" {
			searchClient = opensearch.New(settings.OpenSearchURL, settings.OpenSearchIndex, settings.RequestTimeout)
		}
		go indexer.Run(ctx, client, searchIndex, searchClient, logger, settings.PollInterval)
	}
	if service == role.Import && settings.InternalAPIURL != "" {
		client := workerapi.New(settings.InternalAPIURL, settings.InternalSecret, settings.WorkerID, settings.RequestTimeout)
		handler := importjob.New(
			objecttransfer.New(settings.RequestTimeout),
			importer.Limits{MaxBytes: settings.MaxInputBytes, MaxItems: settings.MaxRecords, MaxEntry: int64(settings.MaxLineBytes)},
			stream.Limits{MaxBytes: settings.MaxInputBytes, MaxLine: settings.MaxLineBytes, MaxRecords: settings.MaxRecords})
		runner, runnerErr := jobrunner.New(client, handler, importjob.Kinds, logger, settings.PollInterval, settings.MaxConcurrency)
		if runnerErr != nil {
			logger.Error("import job runner configuration failed", "error", runnerErr)
			os.Exit(1)
		}
		go runner.Run(ctx)
	}
	if service == role.Export && settings.InternalAPIURL != "" {
		client := workerapi.New(settings.InternalAPIURL, settings.InternalSecret, settings.WorkerID, settings.RequestTimeout)
		handler := exportjob.New(objecttransfer.New(settings.RequestTimeout), stream.Limits{MaxBytes: settings.MaxInputBytes, MaxLine: settings.MaxLineBytes, MaxRecords: settings.MaxRecords})
		runner, runnerErr := jobrunner.New(client, handler, exportjob.Kinds, logger, settings.PollInterval, settings.MaxConcurrency)
		if runnerErr != nil {
			logger.Error("export job runner configuration failed", "error", runnerErr)
			os.Exit(1)
		}
		go runner.Run(ctx)
	}
	go func() {
		logger.Info("go worker listening", "address", settings.Address, "role", service)
		if serveErr := httpServer.ListenAndServe(); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			logger.Error("server stopped unexpectedly", "error", serveErr)
			stop()
		}
	}()

	<-ctx.Done()
	shutdownContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownContext); err != nil {
		logger.Error("server shutdown failed", "error", err)
		os.Exit(1)
	}
	logger.Info("go worker stopped", "role", service)
}

func probeReadiness(ctx context.Context, api *workerapi.Client, search *opensearch.Client, ready *atomic.Bool, interval time.Duration, logger *slog.Logger) {
	probe := func() {
		probeContext, cancel := context.WithTimeout(ctx, min(interval, 5*time.Second))
		defer cancel()
		err := api.Ping(probeContext)
		if err == nil && search != nil {
			err = search.Ping(probeContext)
		}
		ready.Store(err == nil)
		if err != nil {
			logger.Warn("worker dependency readiness failed", "error", err)
		}
	}
	probe()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			ready.Store(false)
			return
		case <-ticker.C:
			probe()
		}
	}
}
