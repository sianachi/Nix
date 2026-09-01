package pluginworker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/broker"
)

type Consumer interface {
	Consume(context.Context, string, string, int, broker.Handler) error
}

type Runner struct {
	consumer      Consumer
	worker        *Worker
	workerID      string
	concurrency   int
	retryInterval time.Duration
	logger        *slog.Logger
}

func NewRunner(consumer Consumer, worker *Worker, workerID string, concurrency int, retryInterval time.Duration, logger *slog.Logger) (*Runner, error) {
	if consumer == nil || worker == nil || workerID == "" || concurrency <= 0 || concurrency > 100 || retryInterval <= 0 || logger == nil {
		return nil, errors.New("plugin event runner configuration is invalid")
	}
	return &Runner{
		consumer: consumer, worker: worker, workerID: workerID,
		concurrency: concurrency, retryInterval: retryInterval, logger: logger,
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
	consumerName := fmt.Sprintf("%s:%s:%d", runner.workerID, broker.PluginEventsQueue, slot)
	for ctx.Err() == nil {
		err := runner.consumer.Consume(ctx, broker.PluginEventsQueue, consumerName, 1, runner.worker.Handle)
		if ctx.Err() != nil {
			return
		}
		runner.logger.Error("plugin broker consumer stopped", "slot", slot, "error", err)
		timer := time.NewTimer(runner.retryInterval)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return
		case <-timer.C:
		}
	}
}
