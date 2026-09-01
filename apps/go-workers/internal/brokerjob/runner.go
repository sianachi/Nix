package brokerjob

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"runtime/debug"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/broker"
	"github.com/sianachi/Nix/apps/go-workers/internal/jobrunner"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
)

type Runner struct {
	broker        *broker.Client
	api           *workerapi.Client
	handler       jobrunner.Handler
	queue         string
	kinds         map[string]struct{}
	workerID      string
	concurrency   int
	leaseDuration time.Duration
	renewInterval time.Duration
	logger        *slog.Logger
}

func New(
	brokerClient *broker.Client,
	api *workerapi.Client,
	handler jobrunner.Handler,
	queue string,
	kinds []string,
	workerID string,
	concurrency int,
	leaseDuration, renewInterval time.Duration,
	logger *slog.Logger,
) (*Runner, error) {
	if brokerClient == nil || api == nil || handler == nil || queue == "" || len(kinds) == 0 || workerID == "" || concurrency <= 0 || concurrency > 100 || leaseDuration < 5*time.Second || leaseDuration > 300*time.Second || renewInterval <= 0 || renewInterval >= leaseDuration || logger == nil {
		return nil, errors.New("broker job runner configuration is invalid")
	}
	allowed := make(map[string]struct{}, len(kinds))
	for _, kind := range kinds {
		allowed[kind] = struct{}{}
	}
	return &Runner{
		broker: brokerClient, api: api, handler: handler, queue: queue, kinds: allowed,
		workerID: workerID, concurrency: concurrency, leaseDuration: leaseDuration,
		renewInterval: renewInterval, logger: logger,
	}, nil
}

func (runner *Runner) Run(ctx context.Context) {
	var wait sync.WaitGroup
	for slot := 0; slot < runner.concurrency; slot++ {
		wait.Add(1)
		go func(slot int) {
			defer wait.Done()
			runner.consume(ctx, slot)
		}(slot)
	}
	wait.Wait()
}

func (runner *Runner) consume(ctx context.Context, slot int) {
	name := fmt.Sprintf("%s:%s:%d", runner.workerID, runner.queue, slot)
	for ctx.Err() == nil {
		err := runner.broker.Consume(ctx, runner.queue, name, 1, runner.handle)
		if ctx.Err() != nil {
			return
		}
		runner.logger.Error("broker consumer stopped", "queue", runner.queue, "slot", slot, "error", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(2 * time.Second):
		}
	}
}

func (runner *Runner) handle(ctx context.Context, envelope broker.Envelope) broker.DeliveryAction {
	command, err := envelope.Command()
	if err != nil {
		runner.logger.Warn("worker command rejected", "message_id", envelope.MessageID, "error", err)
		return broker.Reject
	}
	if _, ok := runner.kinds[command.Kind]; !ok {
		runner.logger.Warn("worker command routed to the wrong queue", "message_id", envelope.MessageID, "kind", command.Kind, "queue", runner.queue)
		return broker.Reject
	}
	executionID, err := executionID(runner.workerID)
	if err != nil {
		runner.logger.Error("worker execution identity could not be generated", "error", err)
		return broker.Requeue
	}
	job, err := runner.api.ClaimJob(ctx, command.JobID, executionID, int(runner.leaseDuration/time.Second))
	if err != nil {
		runner.logger.Error("worker job claim failed", "job_id", command.JobID, "error", err)
		return broker.Requeue
	}
	if job == nil {
		state, stateErr := runner.api.JobState(ctx, command.JobID, executionID)
		if stateErr != nil {
			runner.logger.Error("worker job state lookup failed", "job_id", command.JobID, "error", stateErr)
			return broker.Requeue
		}
		if state == nil || terminal(state.Status) || state.CancellationRequested {
			return broker.Acknowledge
		}
		select {
		case <-ctx.Done():
			return broker.Requeue
		case <-time.After(time.Second):
			return broker.Requeue
		}
	}
	if job.Kind != command.Kind {
		runner.logger.Error("claimed job kind did not match the broker command", "job_id", job.ID, "claimed_kind", job.Kind, "command_kind", command.Kind)
		return broker.Reject
	}

	result, jobErr, leaseLost, cancelled := runner.execute(ctx, *job, executionID)
	if leaseLost || (ctx.Err() != nil && !cancelled) {
		return broker.Requeue
	}
	message := resultMessage(job.ID, executionID, result, jobErr, cancelled, envelope.TraceParent)
	if err := runner.broker.PublishResult(ctx, message); err != nil {
		runner.logger.Error("worker result publish failed", "job_id", job.ID, "error", err)
		return broker.Requeue
	}
	return broker.Acknowledge
}

func (runner *Runner) execute(ctx context.Context, job workerapi.Job, executionID string) (result any, jobErr error, leaseLost, cancelled bool) {
	workContext, cancel := context.WithCancel(ctx)
	defer cancel()
	monitorDone := make(chan struct{})
	var lost atomic.Bool
	var requested atomic.Bool
	go func() {
		defer close(monitorDone)
		ticker := time.NewTicker(runner.renewInterval)
		defer ticker.Stop()
		for {
			select {
			case <-workContext.Done():
				return
			case <-ticker.C:
				state, err := runner.api.JobState(workContext, job.ID, executionID)
				if err != nil || state == nil || !state.LeaseOwned {
					lost.Store(true)
					cancel()
					return
				}
				if state.CancellationRequested {
					requested.Store(true)
					cancel()
					return
				}
				renewed, err := runner.api.RenewJob(workContext, job.ID, executionID, int(runner.leaseDuration/time.Second))
				if err != nil || !renewed {
					lost.Store(true)
					cancel()
					return
				}
			}
		}
	}()
	result, jobErr = runner.handleSafely(workerapi.WithExecution(workContext, job.ID, executionID), job)
	var responseError *workerapi.ResponseError
	if errors.As(jobErr, &responseError) && responseError.Status == 409 {
		lost.Store(true)
	}
	cancel()
	<-monitorDone
	return result, jobErr, lost.Load(), requested.Load()
}

func (runner *Runner) handleSafely(ctx context.Context, job workerapi.Job) (result any, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			runner.logger.Error("worker job panicked", "job_id", job.ID, "kind", job.Kind, "panic", recovered, "stack", string(debug.Stack()))
			err = &jobrunner.JobError{Code: "worker_panic", Detail: "The worker could not complete the job."}
		}
	}()
	return runner.handler.Handle(ctx, job)
}

func resultMessage(jobID, executionID string, result any, jobErr error, cancelled bool, traceParent *string) broker.WorkerResult {
	message := broker.WorkerResult{
		SchemaVersion: broker.SchemaVersion,
		MessageID:     mustMessageID(),
		MessageType:   broker.ResultMessageType,
		OccurredAt:    time.Now().UTC(),
		JobID:         jobID,
		ExecutionID:   executionID,
		Succeeded:     jobErr == nil && !cancelled,
		TraceParent:   traceParent,
	}
	if message.Succeeded {
		if result != nil {
			message.Result, _ = json.Marshal(result)
		}
		return message
	}
	code, detail, retryable := "worker_failed", "The worker could not complete the job.", false
	var typed *jobrunner.JobError
	if errors.As(jobErr, &typed) {
		code, detail, retryable = typed.Code, typed.Error(), typed.Retryable
	} else if cancelled || errors.Is(jobErr, jobrunner.ErrCancelled) || errors.Is(jobErr, context.Canceled) {
		code, detail = "job_cancelled", "The job was cancelled."
	}
	if len(code) > 64 {
		code = code[:64]
	}
	if len(detail) > 2000 {
		detail = detail[:2000]
	}
	message.ErrorCode, message.ErrorDetail, message.Retryable = &code, &detail, retryable
	return message
}

func terminal(status string) bool {
	switch status {
	case "completed", "failed", "cancelled":
		return true
	default:
		return false
	}
}

func executionID(workerID string) (string, error) {
	id, err := randomID()
	if err != nil {
		return "", err
	}
	prefix := strings.TrimSpace(workerID)
	maximumPrefix := 128 - 1 - len(id)
	if len(prefix) > maximumPrefix {
		prefix = prefix[:maximumPrefix]
	}
	return prefix + ":" + id, nil
}

func mustMessageID() string {
	id, err := randomID()
	if err != nil {
		panic(err)
	}
	return id
}

func randomID() (string, error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(bytes[:])
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:32], nil
}
