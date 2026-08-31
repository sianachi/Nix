package httpserver

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/index"
	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
)

type Dependencies struct {
	Logger         *slog.Logger
	InternalSecret string
	MaxInputSize   int64
	MaxRecords     int
	MaxLineBytes   int
	MaxTokens      int
	RequestTimeout time.Duration
}

type Server struct {
	deps  Dependencies
	index *index.Index
}

func New(deps Dependencies) http.Handler {
	server := &Server{deps: deps, index: index.New(deps.MaxTokens)}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", server.health)
	mux.Handle("POST /v1/import/ndjson", server.requireInternal(http.HandlerFunc(server.importNDJSON)))
	mux.Handle("POST /v1/export/ndjson", server.requireInternal(http.HandlerFunc(server.exportNDJSON)))
	mux.Handle("POST /v1/index/ndjson", server.requireInternal(http.HandlerFunc(server.indexNDJSON)))
	mux.Handle("GET /v1/search", server.requireInternal(http.HandlerFunc(server.search)))
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

func (s *Server) indexNDJSON(response http.ResponseWriter, request *http.Request) {
	request.Body = http.MaxBytesReader(response, request.Body, s.deps.MaxInputSize)
	summary, err := stream.ReadRecords(request.Body, s.limits(), func(record stream.Record) error {
		s.index.Put(record)
		return nil
	})
	if err != nil {
		writeStreamError(response, err)
		return
	}
	writeJSON(response, http.StatusAccepted, map[string]any{"status": "indexed", "summary": summary, "indexed": s.index.Len()})
}

func (s *Server) search(response http.ResponseWriter, request *http.Request) {
	query := request.URL.Query().Get("q")
	limit := 20
	if value := request.URL.Query().Get("limit"); value != "" {
		if parsed, err := strconv.Atoi(value); err == nil {
			limit = parsed
		}
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
