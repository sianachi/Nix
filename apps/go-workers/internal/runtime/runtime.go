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

	"github.com/sianachi/Nix/apps/go-workers/internal/broker"
	"github.com/sianachi/Nix/apps/go-workers/internal/brokerjob"
	"github.com/sianachi/Nix/apps/go-workers/internal/config"
	"github.com/sianachi/Nix/apps/go-workers/internal/documentimport"
	"github.com/sianachi/Nix/apps/go-workers/internal/exportjob"
	"github.com/sianachi/Nix/apps/go-workers/internal/fileinspect"
	"github.com/sianachi/Nix/apps/go-workers/internal/httpserver"
	"github.com/sianachi/Nix/apps/go-workers/internal/importer"
	"github.com/sianachi/Nix/apps/go-workers/internal/importjob"
	"github.com/sianachi/Nix/apps/go-workers/internal/importplan"
	"github.com/sianachi/Nix/apps/go-workers/internal/index"
	"github.com/sianachi/Nix/apps/go-workers/internal/indexer"
	"github.com/sianachi/Nix/apps/go-workers/internal/jobrunner"
	"github.com/sianachi/Nix/apps/go-workers/internal/objectcleanup"
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
	roles, err := selectedRoles(service, settings.WorkerRoles)
	if err != nil {
		logger.Error("invalid worker roles", "error", err)
		os.Exit(1)
	}
	if os.Getenv("NIX_WORKER_ADDRESS") == "" {
		settings.Address = ":8301"
	}
	if err := validateSettings(roles, settings); err != nil {
		logger.Error("invalid service configuration", "roles", settings.WorkerRoles, "error", err)
		os.Exit(1)
	}
	if len(os.Args) == 2 && os.Args[1] == "--healthcheck" {
		response, healthErr := http.Get(healthURL(settings.Address))
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
	ready.Store(false)
	server := httpserver.NewForRole(role.All, httpserver.Dependencies{
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
	apiClient := workerapi.New(settings.InternalAPIURL, settings.InternalSecret, settings.WorkerID, settings.RequestTimeout)
	brokerClient, err := broker.New(settings.RabbitMQURL, settings.MaxMessageBytes, logger)
	if err != nil {
		logger.Error("broker configuration failed", "error", err)
		os.Exit(1)
	}
	defer func() {
		if closeErr := brokerClient.Close(); closeErr != nil {
			logger.Warn("broker close failed", "error", closeErr)
		}
	}()
	var searchProbe *opensearch.Client
	if roles.Has(role.Index) && settings.OpenSearchURL != "" {
		searchProbe = opensearch.New(settings.OpenSearchURL, settings.OpenSearchIndex, settings.RequestTimeout)
	}
	go probeReadiness(ctx, apiClient, brokerClient, searchProbe, &ready, settings.PollInterval, logger)
	if roles.Has(role.Index) {
		var searchClient *opensearch.Client
		if settings.OpenSearchURL != "" {
			searchClient = opensearch.New(settings.OpenSearchURL, settings.OpenSearchIndex, settings.RequestTimeout)
		}
		// Workspace events move to RabbitMQ in the indexing milestone. Until then this preserves the
		// existing derived index while import and export commands cut over first.
		go indexer.Run(ctx, apiClient, searchIndex, searchClient, logger, settings.PollInterval)
	}
	if roles.Has(role.Import) {
		transfer := objecttransfer.New(settings.RequestTimeout, settings.ObjectOrigins...)
		imports := importjob.New(
			transfer,
			importer.Limits{MaxBytes: settings.MaxInputBytes, MaxItems: settings.MaxRecords, MaxEntry: int64(settings.MaxLineBytes)},
			stream.Limits{MaxBytes: settings.MaxInputBytes, MaxLine: settings.MaxLineBytes, MaxRecords: settings.MaxRecords})
		files := fileinspect.New(apiClient, transfer, settings.MaxInputBytes)
		cleanup := objectcleanup.New(apiClient, transfer)
		documents, documentsErr := documentimport.New(
			apiClient,
			transfer,
			settings.CollaborationURL,
			settings.InternalSecret,
			importplan.Limits{
				MaxSourceBytes: settings.MaxInputBytes,
				MaxPlanBytes:   16 << 20,
				MaxBodyBytes:   8 << 20,
				MaxEntryBytes:  8 << 20,
				MaxItems:       min(settings.MaxRecords, 10_000),
				MaxDepth:       32,
				PDFTimeoutSecs: max(1, int(settings.RequestTimeout/time.Second)),
			},
			settings.RequestTimeout,
		)
		if documentsErr != nil {
			logger.Error("document import handler configuration failed", "error", documentsErr)
			os.Exit(1)
		}
		routes := make(map[string]jobrunner.Handler, len(importjob.Kinds)+len(documentimport.Kinds)+len(fileinspect.Kinds)+len(objectcleanup.Kinds))
		for _, kind := range importjob.Kinds {
			routes[kind] = imports
		}
		for _, kind := range fileinspect.Kinds {
			routes[kind] = files
		}
		for _, kind := range documentimport.Kinds {
			routes[kind] = documents
		}
		for _, kind := range objectcleanup.Kinds {
			routes[kind] = cleanup
		}
		handler, routeErr := jobrunner.NewRouter(routes)
		if routeErr != nil {
			logger.Error("import handler routing failed", "error", routeErr)
			os.Exit(1)
		}
		kinds := append(append(append(append([]string{}, importjob.Kinds...), documentimport.Kinds...), fileinspect.Kinds...), objectcleanup.Kinds...)
		runner, runnerErr := brokerjob.New(brokerClient, apiClient, handler, broker.ImportQueue, kinds, settings.WorkerID, settings.MaxConcurrency, settings.LeaseDuration, settings.RenewInterval, logger)
		if runnerErr != nil {
			logger.Error("import job runner configuration failed", "error", runnerErr)
			os.Exit(1)
		}
		go runner.Run(ctx)
	}
	if roles.Has(role.Export) {
		handler := exportjob.New(objecttransfer.New(settings.RequestTimeout, settings.ObjectOrigins...), stream.Limits{MaxBytes: settings.MaxInputBytes, MaxLine: settings.MaxLineBytes, MaxRecords: settings.MaxRecords})
		runner, runnerErr := brokerjob.New(brokerClient, apiClient, handler, broker.ExportQueue, exportjob.Kinds, settings.WorkerID, settings.MaxConcurrency, settings.LeaseDuration, settings.RenewInterval, logger)
		if runnerErr != nil {
			logger.Error("export job runner configuration failed", "error", runnerErr)
			os.Exit(1)
		}
		go runner.Run(ctx)
	}
	serverFailures := make(chan error, 1)
	go func() {
		logger.Info("go worker listening", "address", settings.Address, "roles", settings.WorkerRoles)
		if serveErr := httpServer.ListenAndServe(); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			logger.Error("server stopped unexpectedly", "error", serveErr)
			serverFailures <- serveErr
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
	select {
	case <-serverFailures:
		// A listener failure is fatal even though the coordinated shutdown itself succeeded.
		// Returning zero here made IDEs report an early clean exit and hid port collisions.
		os.Exit(1)
	default:
	}
	logger.Info("go worker stopped", "roles", settings.WorkerRoles)
}

func selectedRoles(service role.Service, configured string) (role.Set, error) {
	if service == role.All {
		return role.Parse(configured)
	}
	return role.Set{service: true}, nil
}

func validateSettings(roles role.Set, settings config.Settings) error {
	if len(roles) == 0 {
		return errors.New("at least one worker role is required")
	}
	if settings.InternalAPIURL == "" {
		return errors.New("NIX_WORKER_API_URL is required")
	}
	if settings.InternalSecret == "" {
		return errors.New("NIX_WORKER_INTERNAL_SECRET is required")
	}
	if settings.RabbitMQURL == "" {
		return errors.New("NIX_RABBITMQ_URL is required")
	}
	if roles.Has(role.Import) && settings.CollaborationURL == "" {
		return errors.New("NIX_WORKER_COLLAB_URL is required for document imports")
	}
	return nil
}

func healthURL(address string) string {
	if len(address) > 0 && address[0] == ':' {
		return "http://127.0.0.1" + address + "/healthz"
	}
	return "http://" + address + "/healthz"
}

func probeReadiness(ctx context.Context, api *workerapi.Client, rabbit *broker.Client, search *opensearch.Client, ready *atomic.Bool, interval time.Duration, logger *slog.Logger) {
	probe := func() {
		probeContext, cancel := context.WithTimeout(ctx, min(interval, 5*time.Second))
		defer cancel()
		err := api.Ping(probeContext)
		if err == nil {
			err = rabbit.Ping(probeContext)
		}
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
