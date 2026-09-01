package runtime

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
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
	"github.com/sianachi/Nix/apps/go-workers/internal/pluginruntime"
	"github.com/sianachi/Nix/apps/go-workers/internal/pluginworker"
	"github.com/sianachi/Nix/apps/go-workers/internal/role"
	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
	"github.com/sianachi/Nix/apps/go-workers/internal/worktemp"
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
	if err := worktemp.Sweep(time.Now().UTC(), 24*time.Hour); err != nil {
		logger.Warn("abandoned worker temporary files could not be swept", "error", err)
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
	indexState := indexer.NewState()
	var ready atomic.Bool
	ready.Store(false)
	apiClient := workerapi.New(settings.InternalAPIURL, settings.InternalSecret, settings.WorkerID, settings.RequestTimeout)
	var indexControl httpserver.IndexControl
	var indexHydrator indexer.Hydrator
	if roles.Has(role.Index) && settings.InternalAPIURL != "" {
		indexControl = apiClient
		indexHydrator = apiClient
	}
	server := httpserver.NewForRole(role.All, httpserver.Dependencies{
		Logger:         logger,
		InternalSecret: settings.InternalSecret,
		MaxInputSize:   settings.MaxInputBytes,
		MaxRecords:     settings.MaxRecords,
		MaxLineBytes:   settings.MaxLineBytes,
		MaxTokens:      settings.MaxTokens,
		RequestTimeout: settings.RequestTimeout,
		Index:          searchIndex,
		IndexControl:   indexControl,
		IndexHealth:    indexState.Snapshot,
		Ready: func() bool {
			return ready.Load() && (!roles.Has(role.Index) || indexState.Ready())
		},
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
	var collaborationProbe *serviceProbe
	var objectProbe *objectStoreProbe
	if roles.Has(role.Import) || roles.Has(role.Export) {
		collaborationProbe = newServiceProbe(settings.CollaborationURL, settings.RequestTimeout)
	}
	if roles.Has(role.Import) || roles.Has(role.Export) || roles.Has(role.Plugin) {
		objectProbe = newObjectStoreProbe(settings.ObjectOrigins, settings.RequestTimeout)
	}
	var apiProbe *workerapi.Client
	if settings.InternalAPIURL != "" {
		apiProbe = apiClient
	}
	go probeReadiness(ctx, apiProbe, brokerClient, searchProbe, collaborationProbe, objectProbe, &ready, settings.PollInterval, logger)
	if roles.Has(role.Index) {
		var searchClient *opensearch.Client
		if settings.OpenSearchURL != "" {
			searchClient = opensearch.New(settings.OpenSearchURL, settings.OpenSearchIndex, settings.RequestTimeout)
		}
		go indexer.Run(ctx, brokerClient, indexHydrator, searchIndex, searchClient, indexState, logger, workerInstanceID(settings.WorkerID), settings.MaxRecords, settings.PollInterval)
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
		go advertiseExportFormats(ctx, brokerClient, workerInstanceID(settings.WorkerID), ready.Load, logger)
		handler := exportjob.New(
			apiClient,
			objecttransfer.New(settings.RequestTimeout, settings.CollaborationURL),
			objecttransfer.New(settings.RequestTimeout, settings.ObjectOrigins...),
			settings.InternalSecret,
			stream.Limits{MaxBytes: settings.MaxInputBytes, MaxLine: settings.MaxLineBytes, MaxRecords: settings.MaxRecords})
		runner, runnerErr := brokerjob.New(brokerClient, apiClient, handler, broker.ExportQueue, exportjob.Kinds, settings.WorkerID, settings.MaxConcurrency, settings.LeaseDuration, settings.RenewInterval, logger)
		if runnerErr != nil {
			logger.Error("export job runner configuration failed", "error", runnerErr)
			os.Exit(1)
		}
		go runner.Run(ctx)
	}
	if roles.Has(role.Plugin) {
		pluginRuntime, runtimeErr := pluginruntime.New(pluginruntime.Limits{
			MaxModuleBytes:       int(settings.PluginMaxModuleBytes),
			MaxEventBytes:        settings.MaxMessageBytes,
			MaxHostRequestBytes:  64 << 10,
			MaxHostResponseBytes: 256 << 10,
			MaxHostCalls:         settings.PluginMaxHostCalls,
			MemoryLimitPages:     uint32(settings.PluginMemoryPages),
			ExecutionTimeout:     settings.PluginTimeout,
		})
		if runtimeErr != nil {
			logger.Error("plugin sandbox configuration failed", "error", runtimeErr)
			os.Exit(1)
		}
		worker, workerErr := pluginworker.New(
			apiClient,
			objecttransfer.New(settings.RequestTimeout, settings.ObjectOrigins...),
			pluginRuntime,
			settings.PluginMaxModuleBytes,
			settings.LeaseDuration,
			settings.PollInterval,
			logger,
		)
		if workerErr != nil {
			logger.Error("plugin event worker configuration failed", "error", workerErr)
			os.Exit(1)
		}
		runner, runnerErr := pluginworker.NewRunner(brokerClient, worker, settings.WorkerID, settings.MaxConcurrency, settings.PollInterval, logger)
		if runnerErr != nil {
			logger.Error("plugin event runner configuration failed", "error", runnerErr)
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

func advertiseExportFormats(ctx context.Context, client *broker.Client, instanceID string, isReady func() bool, logger *slog.Logger) {
	formats := []broker.ExportFormatCapability{
		{Format: "nix", Label: "Archive", Extension: "nix", MediaType: "application/vnd.nix.archive+zip", Lossless: true, DeclaredLoss: []string{}},
		{Format: "markdown", Label: "Markdown", Extension: "md", MediaType: "text/markdown; charset=utf-8", DeclaredLoss: []string{"Views and interactive metadata are represented as text."}},
		{Format: "docx", Label: "Word", Extension: "docx", MediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", DeclaredLoss: []string{"Interactive workspace behavior is flattened into a document.", "Links outside HTTP, HTTPS, email, and Nix are flattened to visible labels."}},
		{Format: "pdf", Label: "PDF", Extension: "pdf", MediaType: "application/pdf", DeclaredLoss: []string{"Interactive workspace behavior is flattened into fixed pages.", "Link destinations are printed as labels rather than interactive PDF annotations.", "Characters outside printable ASCII are replaced by the built-in PDF font."}},
	}
	publish := func() {
		if !isReady() {
			return
		}
		messageID, err := client.NewMessageID()
		if err != nil {
			logger.Warn("export capability message identity failed", "error", err)
			return
		}
		now := time.Now().UTC()
		publishContext, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		err = client.PublishCapabilities(publishContext, broker.WorkerCapabilities{
			SchemaVersion: 1,
			MessageID:     messageID,
			MessageType:   "worker.capabilities.v1",
			InstanceID:    instanceID,
			Role:          "export",
			OccurredAt:    now,
			ExpiresAt:     now.Add(90 * time.Second),
			ExportFormats: formats,
		})
		if err != nil && ctx.Err() == nil {
			logger.Warn("export capability advertisement failed", "error", err)
		}
	}
	readiness := time.NewTicker(100 * time.Millisecond)
	for !isReady() {
		select {
		case <-ctx.Done():
			readiness.Stop()
			return
		case <-readiness.C:
		}
	}
	readiness.Stop()
	publish()
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			publish()
		}
	}
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
	if settings.InternalSecret == "" {
		return errors.New("NIX_WORKER_INTERNAL_SECRET is required")
	}
	if settings.InternalAPIURL == "" {
		return errors.New("NIX_WORKER_API_URL is required for every enabled role")
	}
	if settings.RabbitMQURL == "" {
		return errors.New("NIX_RABBITMQ_URL is required")
	}
	if roles.Has(role.Import) || roles.Has(role.Export) {
		if !validServiceOrigin(settings.CollaborationURL) {
			return errors.New("NIX_WORKER_COLLAB_URL must be a valid collaboration service origin for imports and exports")
		}
	}
	if roles.Has(role.Import) || roles.Has(role.Export) || roles.Has(role.Plugin) {
		if len(settings.ObjectOrigins) == 0 {
			return errors.New("NIX_WORKER_OBJECT_ORIGINS is required for imports, exports, and plugins")
		}
	}
	if roles.Has(role.Index) {
		if !validServiceOrigin(settings.OpenSearchURL) {
			return errors.New("NIX_OPENSEARCH_URL must be a valid OpenSearch origin for indexing")
		}
		if err := opensearch.ValidateIndexName(settings.OpenSearchIndex); err != nil {
			return fmt.Errorf("NIX_OPENSEARCH_INDEX must be an exact safe index name: %w", err)
		}
	}
	return nil
}

func validServiceOrigin(raw string) bool {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	return err == nil &&
		parsed.Host != "" &&
		parsed.User == nil &&
		parsed.RawQuery == "" &&
		parsed.Fragment == "" &&
		(parsed.Path == "" || parsed.Path == "/") &&
		(parsed.Scheme == "https" ||
			parsed.Scheme == "http" && (parsed.IsAbs() && (!strings.Contains(parsed.Hostname(), ".") || parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "::1")))
}

func workerInstanceID(workerID string) string {
	host, err := os.Hostname()
	if err != nil || strings.TrimSpace(host) == "" {
		host = "unknown-host"
	}
	instance := strings.TrimSpace(workerID) + ":" + host + ":" + strconv.Itoa(os.Getpid())
	if len(instance) > 128 {
		return instance[:128]
	}
	return instance
}

func healthURL(address string) string {
	if len(address) > 0 && address[0] == ':' {
		return "http://127.0.0.1" + address + "/healthz"
	}
	return "http://" + address + "/healthz"
}

type serviceProbe struct {
	url    string
	client *http.Client
}

type objectStoreProbe struct {
	urls   []string
	client *http.Client
}

func newObjectStoreProbe(origins []string, timeout time.Duration) *objectStoreProbe {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DisableCompression = true
	urls := make([]string, 0, len(origins))
	for _, origin := range origins {
		urls = append(urls, strings.TrimRight(origin, "/")+"/")
	}
	return &objectStoreProbe{
		urls: urls,
		client: &http.Client{
			Timeout:       timeout,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
			Transport:     transport,
		},
	}
}

func newServiceProbe(origin string, timeout time.Duration) *serviceProbe {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DisableCompression = true
	return &serviceProbe{
		url: strings.TrimRight(origin, "/") + "/healthz",
		client: &http.Client{
			Timeout:       timeout,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
			Transport:     transport,
		},
	}
}

func (probe *serviceProbe) Ping(ctx context.Context) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, probe.url, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	response, err := probe.client.Do(request)
	if err != nil {
		return err
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4<<10))
	closeErr := response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("dependency health check returned %s", response.Status)
	}
	return closeErr
}

func (probe *objectStoreProbe) Ping(ctx context.Context) error {
	if probe == nil || len(probe.urls) == 0 {
		return errors.New("object storage readiness has no configured origin")
	}
	for _, endpoint := range probe.urls {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			return err
		}
		request.Header.Set("Accept", "application/xml, application/json")
		request.Header.Set("Range", "bytes=0-0")
		response, err := probe.client.Do(request)
		if err != nil {
			return err
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4<<10))
		closeErr := response.Body.Close()
		// Private S3-compatible stores normally answer an anonymous root request with 401 or 403.
		// That is a useful readiness result: workers deliberately hold no long-lived storage
		// credential, and use a signed capability only after they lease a job.
		if response.StatusCode < 200 || response.StatusCode >= 500 || response.StatusCode/100 == 3 {
			return fmt.Errorf("object storage readiness returned %s", response.Status)
		}
		if closeErr != nil {
			return closeErr
		}
	}
	return nil
}

func probeReadiness(ctx context.Context, api *workerapi.Client, rabbit *broker.Client, search *opensearch.Client, collaboration *serviceProbe, objects *objectStoreProbe, ready *atomic.Bool, interval time.Duration, logger *slog.Logger) {
	probe := func() {
		probeContext, cancel := context.WithTimeout(ctx, min(interval, 5*time.Second))
		defer cancel()
		var err error
		if api != nil {
			err = api.Ping(probeContext)
		}
		if err == nil {
			err = rabbit.Ping(probeContext)
		}
		if err == nil && search != nil {
			err = search.Ping(probeContext)
		}
		if err == nil && collaboration != nil {
			err = collaboration.Ping(probeContext)
		}
		if err == nil && objects != nil {
			err = objects.Ping(probeContext)
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
