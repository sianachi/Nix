package httpserver

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
)

type Dependencies struct {
	Logger         *slog.Logger
	InternalSecret string
	MaxInputSize   int64
	MaxRecords     int
	MaxLineBytes   int
}

type Server struct {
	deps Dependencies
}

func New(deps Dependencies) http.Handler {
	server := &Server{deps: deps}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", server.health)
	mux.Handle("POST /v1/import/ndjson", server.requireInternal(http.HandlerFunc(server.importNDJSON)))
	mux.Handle("POST /v1/export/ndjson", server.requireInternal(http.HandlerFunc(server.exportNDJSON)))
	return requestTimeout(mux, 65*time.Second)
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
	var records []stream.Record
	if _, err := stream.ReadRecords(request.Body, s.limits(), func(record stream.Record) error {
		records = append(records, record)
		return nil
	}); err != nil {
		writeStreamError(response, err)
		return
	}
	response.Header().Set("Content-Type", "application/x-ndjson")
	response.WriteHeader(http.StatusOK)
	if _, err := stream.WriteRecords(response, records, s.limits()); err != nil {
		s.deps.Logger.Error("export stream failed", "error", err)
	}
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
	return http.TimeoutHandler(next, timeout, `{"code":"request_timeout","detail":"The worker request timed out."}`)
}
