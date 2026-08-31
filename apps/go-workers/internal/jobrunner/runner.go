package jobrunner

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"runtime/debug"
	"sync"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
)

var ErrCancelled = errors.New("job cancellation was requested")

type Handler interface {
	Handle(context.Context, workerapi.Job) (any, error)
}

type JobError struct {
	Code   string
	Detail string
	Cause  error
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

type Runner struct {
	client      *workerapi.Client
	handler     Handler
	kinds       []string
	logger      *slog.Logger
	interval    time.Duration
	concurrency int
	semaphore   chan struct{}
	wait        sync.WaitGroup
}

func New(client *workerapi.Client, handler Handler, kinds []string, logger *slog.Logger, interval time.Duration, concurrency int) (*Runner, error) {
	if client == nil || handler == nil || logger == nil || len(kinds) == 0 || interval <= 0 || concurrency <= 0 || concurrency > 100 {
		return nil, errors.New("job runner configuration is invalid")
	}
	return &Runner{client: client, handler: handler, kinds: append([]string(nil), kinds...), logger: logger, interval: interval, concurrency: concurrency, semaphore: make(chan struct{}, concurrency)}, nil
}

func (runner *Runner) Run(ctx context.Context) {
	runner.poll(ctx)
	ticker := time.NewTicker(runner.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			runner.wait.Wait()
			return
		case <-ticker.C:
			runner.poll(ctx)
		}
	}
}

func (runner *Runner) poll(ctx context.Context) {
	available := runner.concurrency - len(runner.semaphore)
	if available <= 0 {
		return
	}
	perKind := max(1, available/len(runner.kinds))
	for _, kind := range runner.kinds {
		if available <= 0 || ctx.Err() != nil {
			return
		}
		limit := min(perKind, available)
		jobs, err := runner.client.LeaseJobs(ctx, kind, limit)
		if err != nil {
			runner.logger.Error("worker job lease failed", "kind", kind, "error", err)
			continue
		}
		for _, job := range jobs {
			if available <= 0 {
				return
			}
			runner.semaphore <- struct{}{}
			runner.wait.Add(1)
			available--
			go runner.execute(ctx, job)
		}
	}
}

func (runner *Runner) execute(ctx context.Context, job workerapi.Job) {
	defer func() {
		<-runner.semaphore
		runner.wait.Done()
	}()
	if job.CancellationRequested {
		runner.finish(ctx, job, nil, ErrCancelled)
		return
	}
	result, err := runner.handleSafely(ctx, job)
	runner.finish(ctx, job, result, err)
}

func (runner *Runner) handleSafely(ctx context.Context, job workerapi.Job) (result any, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			runner.logger.Error("worker job panicked", "job_id", job.ID, "kind", job.Kind, "panic", recovered, "stack", string(debug.Stack()))
			err = &JobError{Code: "worker_panic", Detail: "The worker could not complete the job."}
		}
	}()
	return runner.handler.Handle(ctx, job)
}

func (runner *Runner) finish(ctx context.Context, job workerapi.Job, result any, jobErr error) {
	completionContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	if jobErr == nil {
		if err := runner.client.CompleteJob(completionContext, job.ID, true, result, nil, nil); err != nil {
			runner.logger.Error("worker job completion failed", "job_id", job.ID, "error", err)
		}
		return
	}
	code, detail := "worker_failed", "The worker could not complete the job."
	var typed *JobError
	if errors.As(jobErr, &typed) {
		code, detail = typed.Code, typed.Error()
	} else if errors.Is(jobErr, ErrCancelled) || errors.Is(jobErr, context.Canceled) {
		code, detail = "job_cancelled", "The job was cancelled."
	}
	if err := runner.client.CompleteJob(completionContext, job.ID, false, nil, code, detail); err != nil {
		runner.logger.Error("worker job failure could not be recorded", "job_id", job.ID, "error", err)
		return
	}
	runner.logger.Warn("worker job failed", "job_id", job.ID, "kind", job.Kind, "code", code, "attempt", job.Attempts, "error", fmt.Sprintf("%v", jobErr))
}
