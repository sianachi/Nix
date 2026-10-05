package jobrunner

import (
	"context"
	"errors"

	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
)

type Router struct {
	handlers map[string]Handler
}

func NewRouter(handlers map[string]Handler) (*Router, error) {
	if len(handlers) == 0 {
		return nil, errors.New("job handler router is empty")
	}
	copy := make(map[string]Handler, len(handlers))
	for kind, handler := range handlers {
		if kind == "" || handler == nil {
			return nil, errors.New("job handler route is invalid")
		}
		copy[kind] = handler
	}
	return &Router{handlers: copy}, nil
}

func (router *Router) Handle(ctx context.Context, job workerapi.Job) (any, error) {
	handler, ok := router.handlers[job.Kind]
	if !ok {
		return nil, &JobError{Code: "worker_kind_unsupported", Detail: "No handler accepts this worker job kind."}
	}
	return handler.Handle(ctx, job)
}
