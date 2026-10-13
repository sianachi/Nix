package jobrunner

import (
	"context"
	"errors"

	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
)

var ErrCancelled = errors.New("job cancellation was requested")

type Handler interface {
	Handle(context.Context, workerapi.Job) (any, error)
}

type JobError struct {
	Code      string
	Detail    string
	Cause     error
	Retryable bool
}

func (err *JobError) Error() string {
	if err.Detail != "" {
		return err.Detail
	}
	if err.Cause != nil {
		return err.Cause.Error()
	}
	return err.Code
}

func (err *JobError) Unwrap() error { return err.Cause }
