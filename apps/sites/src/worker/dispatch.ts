import { randomUUID } from 'node:crypto';

import { CoreResponseError, type CoreClient, type Execution } from './core-client.ts';

/**
 * Claim, renew and result for one broker delivery: a port of the Go `brokerjob.Runner`.
 *
 * Core owns the durable job and its lease; the broker only says "look at this job". The runner
 * claims it under a fresh execution id, keeps the lease alive while the handler works, and hands
 * the outcome back as a result message (never an HTTP complete). A lease lost mid-run, or a
 * delivery that cannot be settled, requeues the message so another execution can take over.
 */

export interface LeaseJob {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId: string | null;
  readonly actorId: string | null;
  readonly kind: string;
  readonly payload: unknown;
  readonly attempts: number;
  readonly cancellationRequested: boolean;
}

export interface JobState {
  readonly status: string;
  readonly cancellationRequested: boolean;
  readonly leaseOwned: boolean;
  readonly leaseUntil: string | null;
}

/** A failure the handler wants reported with a code, as the Go `jobrunner.JobError`. */
export class JobError extends Error {
  override readonly name = 'JobError';
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, detail: string, retryable = false) {
    super(detail);
    this.code = code;
    this.retryable = retryable;
  }
}

export interface JobContext {
  readonly job: LeaseJob;
  readonly execution: Execution;
  /** Aborts when the lease is lost or cancellation is requested. */
  readonly signal: AbortSignal;
}

export type JobHandler = (context: JobContext) => Promise<unknown>;

export interface WorkerResult {
  readonly schemaVersion: 1;
  readonly messageId: string;
  readonly messageType: 'worker.result.v1';
  readonly occurredAt: string;
  readonly jobId: string;
  readonly executionId: string;
  readonly succeeded: boolean;
  readonly retryable: boolean;
  readonly result?: unknown;
  readonly errorCode?: string;
  readonly errorDetail?: string;
  readonly traceParent?: string;
}

export type DeliveryAction = 'ack' | 'requeue' | 'reject';

export interface ResultPublisher {
  publishResult(result: WorkerResult): Promise<void>;
}

export interface RunnerOptions {
  readonly core: Pick<CoreClient, 'claim' | 'renew' | 'state'>;
  readonly publisher: ResultPublisher;
  /** Job kind to handler. A kind not listed is rejected. */
  readonly handlers: Readonly<Record<string, JobHandler>>;
  readonly workerId: string;
  readonly leaseSeconds: number;
  readonly renewSeconds: number;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
  /** Injected for tests. */
  readonly newId?: () => string;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

export interface CommandReference {
  readonly jobId: string;
  readonly kind: string;
}

export class JobRunner {
  private readonly log: (message: string, fields?: Record<string, unknown>) => void;
  private readonly newId: () => string;

  private readonly options: RunnerOptions;

  constructor(options: RunnerOptions) {
    this.options = options;
    this.log = options.log ?? (() => undefined);
    this.newId = options.newId ?? randomUUID;
  }

  executionId(): string {
    const id = this.newId();
    const prefix = this.options.workerId.trim().slice(0, 128 - 1 - id.length);
    return `${prefix}:${id}`;
  }

  async handle(command: CommandReference, traceParent: string | null): Promise<DeliveryAction> {
    const handler = this.options.handlers[command.kind];
    if (handler === undefined) {
      this.log('worker command routed to the wrong queue', { kind: command.kind });
      return 'reject';
    }

    const executionId = this.executionId();
    let job: LeaseJob | null;
    try {
      job = await this.options.core.claim(command.jobId, executionId, this.options.leaseSeconds);
    } catch (error) {
      this.log('worker job claim failed', { jobId: command.jobId, error: String(error) });
      return 'requeue';
    }

    if (job === null) {
      try {
        const state = await this.options.core.state(command.jobId, executionId);
        if (state === null || TERMINAL.has(state.status) || state.cancellationRequested) {
          return 'ack';
        }
      } catch {
        return 'requeue';
      }
      // Another execution holds a live lease; look again after it has had a moment to finish.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return 'requeue';
    }
    if (job.kind !== command.kind) {
      this.log('claimed job kind did not match the broker command', { jobId: job.id });
      return 'reject';
    }

    const outcome = await this.execute(job, executionId, handler);
    if (outcome.leaseLost) return 'requeue';

    try {
      await this.options.publisher.publishResult(
        this.resultMessage(job.id, executionId, outcome, traceParent),
      );
    } catch (error) {
      this.log('worker result publish failed', { jobId: job.id, error: String(error) });
      return 'requeue';
    }
    return 'ack';
  }

  private async execute(job: LeaseJob, executionId: string, handler: JobHandler): Promise<Outcome> {
    const work = new AbortController();
    // A holder rather than two lets: the timer callback writes them while the handler runs.
    const flags = { leaseLost: false, cancelled: false };
    const { core, leaseSeconds, renewSeconds } = this.options;

    const timer = setInterval(() => {
      void (async () => {
        try {
          const state = await core.state(job.id, executionId, work.signal);
          if (!state?.leaseOwned) {
            flags.leaseLost = true;
          } else if (state.cancellationRequested) {
            flags.cancelled = true;
          } else if (!(await core.renew(job.id, executionId, leaseSeconds, work.signal))) {
            flags.leaseLost = true;
          }
        } catch {
          // A failed lease check is a lost lease: the work must not outlive what protects it.
          flags.leaseLost = true;
        }
        if (flags.leaseLost || flags.cancelled) work.abort();
      })();
    }, renewSeconds * 1000);

    let value: unknown;
    let failure: unknown = null;
    try {
      value = await handler({
        job,
        execution: { jobId: job.id, executionId },
        signal: work.signal,
      });
    } catch (error) {
      failure = error;
    } finally {
      clearInterval(timer);
    }

    if (failure instanceof CoreResponseError && failure.status === 409 && !flags.leaseLost) {
      // A 409 is "your lease is gone" or a refusal of this particular request. Ask Core which.
      try {
        const state = await core.state(job.id, executionId);
        if (!state?.leaseOwned) flags.leaseLost = true;
      } catch {
        flags.leaseLost = true;
      }
    }
    work.abort();
    return { value, failure, leaseLost: flags.leaseLost, cancelled: flags.cancelled };
  }

  private resultMessage(
    jobId: string,
    executionId: string,
    outcome: Outcome,
    traceParent: string | null,
  ): WorkerResult {
    const base = {
      schemaVersion: 1 as const,
      messageId: this.newId(),
      messageType: 'worker.result.v1' as const,
      occurredAt: new Date().toISOString(),
      jobId,
      executionId,
      ...(traceParent === null ? {} : { traceParent }),
    };
    if (outcome.cancelled) {
      return {
        ...base,
        succeeded: false,
        retryable: false,
        errorCode: 'job_cancelled',
        errorDetail: 'The job was cancelled.',
      };
    }
    if (outcome.failure === null) {
      return {
        ...base,
        succeeded: true,
        retryable: false,
        ...(outcome.value === undefined ? {} : { result: outcome.value }),
      };
    }
    const failure = outcome.failure;
    let code = 'worker_failed';
    let detail = 'The worker could not complete the job.';
    let retryable = false;
    if (failure instanceof JobError) {
      code = failure.code;
      detail = failure.message;
      retryable = failure.retryable;
    } else if (failure instanceof CoreResponseError) {
      code = 'core_refused';
      detail = `Core refused a request${failure.code === null ? '' : ` (${failure.code})`}: ${failure.detail}`;
    }
    if (!ERROR_CODE.test(code)) code = 'worker_failed';
    return {
      ...base,
      succeeded: false,
      retryable,
      errorCode: code,
      errorDetail: detail.slice(0, 2000),
    };
  }
}

interface Outcome {
  readonly value: unknown;
  readonly failure: unknown;
  readonly leaseLost: boolean;
  readonly cancelled: boolean;
}
