package httpserver

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/exporter"
	"github.com/sianachi/Nix/apps/go-workers/internal/importer"
	"github.com/sianachi/Nix/apps/go-workers/internal/index"
	"github.com/sianachi/Nix/apps/go-workers/internal/indexer"
	"github.com/sianachi/Nix/apps/go-workers/internal/role"
	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
)

type IndexControl interface {
	EnqueueIndexRebuild(context.Context, workerapi.IndexRebuildRequest) (*workerapi.IndexRebuildPage, error)
	GetIndexStatus(context.Context) (*workerapi.IndexQueueStatus, error)
}

type Dependencies struct {
	Logger         *slog.Logger
	InternalSecret string
	MaxInputSize   int64
	MaxRecords     int
	MaxLineBytes   int
	MaxTokens      int
	RequestTimeout time.Duration
	Index          *index.Index
	IndexControl   IndexControl
	IndexHealth    func() indexer.Health
	Ready          func() bool
	Companion      http.Handler
}

type Server struct {
	deps  Dependencies
	index *index.Index
}

func New(deps Dependencies) http.Handler {
	return NewForRole(role.All, deps)
}

func NewForRole(service role.Service, deps Dependencies) http.Handler {
	searchIndex := deps.Index
	if searchIndex == nil {
		searchIndex = index.New(deps.MaxTokens, deps.MaxRecords)
	}
	server := &Server{deps: deps, index: searchIndex}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", server.health)
	mux.HandleFunc("GET /readyz", server.ready)
	if deps.Companion != nil {
		mux.Handle("POST /v1/companion", server.requireInternal(deps.Companion))
	}
	if service == role.All || service == role.Import {
		mux.Handle("POST /v1/import/ndjson", server.requireInternal(http.HandlerFunc(server.importNDJSON)))
		mux.Handle("POST /v1/import/document", server.requireInternal(http.HandlerFunc(server.importDocument)))
	}
	if service == role.All || service == role.Export {
		mux.Handle("POST /v1/export/ndjson", server.requireInternal(http.HandlerFunc(server.exportNDJSON)))
		mux.Handle("POST /v1/export/document", server.requireInternal(http.HandlerFunc(server.exportDocument)))
	}
	if service == role.All || service == role.Index {
		mux.Handle("POST /v1/index/ndjson", server.requireInternal(http.HandlerFunc(server.indexNDJSON)))
		mux.Handle("POST /v1/index/rebuild", server.requireInternal(http.HandlerFunc(server.rebuildIndex)))
		mux.Handle("POST /v1/index/restore", server.requireInternal(http.HandlerFunc(server.restoreIndex)))
		mux.Handle("GET /v1/index/snapshot", server.requireInternal(http.HandlerFunc(server.snapshot)))
		mux.Handle("GET /v1/index/status", server.requireInternal(http.HandlerFunc(server.indexStatus)))
		mux.Handle("GET /v1/search", server.requireInternal(http.HandlerFunc(server.search)))
	}
	timeout := deps.RequestTimeout
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	return requestTimeout(mux, timeout)
}

func (s *Server) requireInternal(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		presented := request.Header.Get("X-Nix-Internal-Secret")
		if s.deps.InternalSecret == "" || presented == "" || !sameSecret(presented, s.deps.InternalSecret) {
			writeJSON(response, http.StatusUnauthorized, map[string]string{
				"code":   "internal_auth_required",
				"detail": "A trusted service credential is required.",
			})
			return
		}
		next.ServeHTTP(response, request)
	})
}

func sameSecret(presented, expected string) bool {
	if len(presented) != len(expected) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(presented), []byte(expected)) == 1
}

func (s *Server) health(response http.ResponseWriter, _ *http.Request) {
	writeJSON(response, http.StatusOK, map[string]string{"status": "healthy"})
}

func (s *Server) ready(response http.ResponseWriter, _ *http.Request) {
	if s.deps.Ready != nil && !s.deps.Ready() {
		writeJSON(response, http.StatusServiceUnavailable, map[string]string{"status": "not_ready"})
		return
	}
	writeJSON(response, http.StatusOK, map[string]string{"status": "ready"})
}

func (s *Server) importNDJSON(response http.ResponseWriter, request *http.Request) {
	request.Body = http.MaxBytesReader(response, request.Body, s.deps.MaxInputSize)
	summary, err := stream.ReadRecords(request.Body, s.limits(), func(stream.Record) error {
		// This first slice validates and counts the stream. Durable item creation will be added only
		// after the Nix.Api job contract exists; this worker never receives database credentials.
		return nil
	})
	if err != nil {
		writeStreamError(response, err)
		return
	}
	writeJSON(response, http.StatusAccepted, map[string]any{"status": "validated", "summary": summary})
}

func (s *Server) importDocument(response http.ResponseWriter, request *http.Request) {
	query := request.URL.Query()
	format, id, title := query.Get("format"), query.Get("id"), query.Get("title")
	if format == "" || id == "" || title == "" {
		writeJSON(response, http.StatusBadRequest, map[string]string{"code": "import_invalid", "detail": "format, id, and title are required."})
		return
	}
	request.Body = http.MaxBytesReader(response, request.Body, s.deps.MaxInputSize)
	result, err := importer.Parse(format, id, title, request.Body, importer.Limits{MaxBytes: s.deps.MaxInputSize, MaxItems: s.deps.MaxRecords, MaxEntry: int64(s.deps.MaxLineBytes)})
	if err != nil {
		writeStreamError(response, err)
		return
	}
	writeJSON(response, http.StatusAccepted, result)
}

func (s *Server) exportNDJSON(response http.ResponseWriter, request *http.Request) {
	request.Body = http.MaxBytesReader(response, request.Body, s.deps.MaxInputSize)
	response.Header().Set("Content-Type", "application/x-ndjson")
	response.WriteHeader(http.StatusOK)
	writer := stream.NewWriter(response, s.limits())
	if _, err := stream.ReadRecords(request.Body, s.limits(), func(record stream.Record) error {
		return writer.Write(record)
	}); err != nil {
		if s.deps.Logger != nil {
			s.deps.Logger.Error("export stream refused", "error", err, "records", writer.Summary().Records)
		}
		return
	}
}

func (s *Server) exportDocument(response http.ResponseWriter, request *http.Request) {
	format := request.URL.Query().Get("format")
	if format == "" {
		writeJSON(response, http.StatusBadRequest, map[string]string{"code": "export_invalid", "detail": "format is required."})
		return
	}
	request.Body = http.MaxBytesReader(response, request.Body, s.deps.MaxInputSize)
	records := make([]stream.Record, 0)
	if _, err := stream.ReadRecords(request.Body, s.limits(), func(record stream.Record) error {
		records = append(records, record)
		return nil
	}); err != nil {
		writeStreamError(response, err)
		return
	}
	var output bytes.Buffer
	if err := exporter.Write(format, records, &output, s.limits()); err != nil {
		writeStreamError(response, err)
		return
	}
	contentType := "application/octet-stream"
	if format == "markdown" || format == "md" {
		contentType = "text/markdown; charset=utf-8"
	} else if format == "ndjson" || format == "jsonl" {
		contentType = "application/x-ndjson"
	}
	response.Header().Set("Content-Type", contentType)
	response.WriteHeader(http.StatusOK)
	_, _ = response.Write(output.Bytes())
}

func (s *Server) indexNDJSON(response http.ResponseWriter, request *http.Request) {
	request.Body = http.MaxBytesReader(response, request.Body, s.deps.MaxInputSize)
	summary, err := stream.ReadRecords(request.Body, s.limits(), func(record stream.Record) error {
		return s.index.Put(record)
	})
	if err != nil {
		if errors.Is(err, index.ErrCapacityExceeded) {
			writeJSON(response, http.StatusInsufficientStorage, map[string]string{"code": "index_capacity_exceeded", "detail": err.Error()})
			return
		}
		writeStreamError(response, err)
		return
	}
	writeJSON(response, http.StatusAccepted, map[string]any{"status": "indexed", "summary": summary, "indexed": s.index.Len()})
}

func (s *Server) rebuildIndex(response http.ResponseWriter, request *http.Request) {
	if isJSONRequest(request) {
		s.enqueueRebuildPage(response, request)
		return
	}
	request.Body = http.MaxBytesReader(response, request.Body, s.deps.MaxInputSize)
	records := make([]stream.Record, 0)
	if _, err := stream.ReadRecords(request.Body, s.limits(), func(record stream.Record) error {
		records = append(records, record)
		return nil
	}); err != nil {
		writeStreamError(response, err)
		return
	}
	if err := s.index.Replace(records); err != nil {
		if errors.Is(err, index.ErrCapacityExceeded) {
			writeJSON(response, http.StatusInsufficientStorage, map[string]string{"code": "index_capacity_exceeded", "detail": err.Error()})
			return
		}
		writeJSON(response, http.StatusBadRequest, map[string]string{"code": "index_invalid", "detail": err.Error()})
		return
	}
	writeJSON(response, http.StatusAccepted, map[string]any{"status": "rebuilt", "indexed": s.index.Len()})
}

func (s *Server) enqueueRebuildPage(response http.ResponseWriter, request *http.Request) {
	if s.deps.IndexControl == nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]string{"code": "index_control_unavailable", "detail": "Durable index rebuild is not configured."})
		return
	}
	request.Body = http.MaxBytesReader(response, request.Body, 64<<10)
	var rebuild workerapi.IndexRebuildRequest
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&rebuild); err != nil {
		writeJSON(response, http.StatusBadRequest, map[string]string{"code": "index_rebuild_invalid", "detail": "The rebuild cursor is not valid JSON."})
		return
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		writeJSON(response, http.StatusBadRequest, map[string]string{"code": "index_rebuild_invalid", "detail": "The rebuild request must contain one JSON object."})
		return
	}
	if (rebuild.AfterTenantID == nil) != (rebuild.AfterItemID == nil) || rebuild.Limit != nil && (*rebuild.Limit < 1 || *rebuild.Limit > 1000) || rebuild.AfterTenantID != nil && !canonicalUUID(*rebuild.AfterTenantID) || rebuild.AfterItemID != nil && !canonicalUUID(*rebuild.AfterItemID) || rebuild.UpdatedSince != nil && rebuild.UpdatedSince.IsZero() {
		writeJSON(response, http.StatusBadRequest, map[string]string{"code": "index_rebuild_invalid", "detail": "The rebuild cursor and limit are invalid."})
		return
	}
	page, err := s.deps.IndexControl.EnqueueIndexRebuild(request.Context(), rebuild)
	if err != nil || page == nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]string{"code": "index_rebuild_unavailable", "detail": "The durable rebuild page could not be enqueued."})
		return
	}
	writeJSON(response, http.StatusAccepted, map[string]any{
		"status": "page_enqueued", "enqueued": page.Enqueued, "nextTenantId": page.NextTenantID,
		"nextItemId": page.NextItemID, "hasMore": page.HasMore,
	})
}

func (s *Server) indexStatus(response http.ResponseWriter, request *http.Request) {
	var durable *workerapi.IndexQueueStatus
	if s.deps.IndexControl != nil {
		var err error
		durable, err = s.deps.IndexControl.GetIndexStatus(request.Context())
		if err != nil {
			writeJSON(response, http.StatusServiceUnavailable, map[string]string{"code": "index_status_unavailable", "detail": "The durable index queue status is unavailable."})
			return
		}
	}
	var consumer any
	if s.deps.IndexHealth != nil {
		consumer = s.deps.IndexHealth()
	}
	writeJSON(response, http.StatusOK, map[string]any{"durable": durable, "consumer": consumer})
}

func (s *Server) snapshot(response http.ResponseWriter, _ *http.Request) {
	writeJSON(response, http.StatusOK, s.index.Snapshot())
}

func (s *Server) restoreIndex(response http.ResponseWriter, request *http.Request) {
	request.Body = http.MaxBytesReader(response, request.Body, s.deps.MaxInputSize)
	var snapshot index.Snapshot
	if err := json.NewDecoder(request.Body).Decode(&snapshot); err != nil {
		writeJSON(response, http.StatusBadRequest, map[string]string{"code": "index_invalid", "detail": "The index snapshot is not valid JSON."})
		return
	}
	if snapshot.Version != 1 {
		writeJSON(response, http.StatusBadRequest, map[string]string{"code": "index_invalid", "detail": "The index snapshot version is unsupported."})
		return
	}
	if err := s.index.Replace(snapshot.Records); err != nil {
		writeJSON(response, http.StatusBadRequest, map[string]string{"code": "index_invalid", "detail": err.Error()})
		return
	}
	writeJSON(response, http.StatusAccepted, map[string]any{"status": "restored", "indexed": s.index.Len()})
}

func (s *Server) search(response http.ResponseWriter, request *http.Request) {
	query := request.URL.Query().Get("q")
	limit := 20
	if value := request.URL.Query().Get("limit"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil {
			writeJSON(response, http.StatusBadRequest, map[string]string{"code": "search_invalid", "detail": "limit must be an integer between 1 and 100."})
			return
		}
		limit = parsed
	}
	if query == "" || len(query) > s.deps.MaxLineBytes || limit < 1 || limit > 100 {
		writeJSON(response, http.StatusBadRequest, map[string]string{"code": "search_invalid", "detail": "q is required and limit must be between 1 and 100."})
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"query": query, "results": s.index.Search(query, limit)})
}

func (s *Server) limits() stream.Limits {
	return stream.Limits{MaxBytes: s.deps.MaxInputSize, MaxLine: s.deps.MaxLineBytes, MaxRecords: s.deps.MaxRecords}
}

func writeStreamError(response http.ResponseWriter, err error) {
	status := http.StatusBadRequest
	if errors.Is(err, stream.ErrLimitExceeded) {
		status = http.StatusRequestEntityTooLarge
	}
	writeJSON(response, status, map[string]string{"code": "stream_refused", "detail": err.Error()})
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}

func requestTimeout(next http.Handler, timeout time.Duration) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requestContext, cancel := context.WithTimeout(request.Context(), timeout)
		defer cancel()
		next.ServeHTTP(response, request.WithContext(requestContext))
	})
}

func isJSONRequest(request *http.Request) bool {
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	return err == nil && strings.EqualFold(mediaType, "application/json")
}

func canonicalUUID(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return false
	}
	for position, character := range value {
		if position == 8 || position == 13 || position == 18 || position == 23 {
			continue
		}
		if character < '0' || character > '9' && character < 'a' || character > 'f' {
			return false
		}
	}
	return value != "00000000-0000-0000-0000-000000000000"
}
