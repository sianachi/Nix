import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CoreResponseError } from './core-client.ts';
import {
  JobError,
  JobRunner,
  type JobHandler,
  type JobState,
  type LeaseJob,
  type WorkerResult,
} from './dispatch.ts';

const JOB = '10000000-0000-4000-8000-000000000001';
const job: LeaseJob = {
  id: JOB,
  tenantId: 't',
  workspaceId: 'w',
  actorId: 'a',
  kind: 'site.build',
  payload: {},
  attempts: 1,
  cancellationRequested: false,
};
const owned: JobState = {
  status: 'running',
  cancellationRequested: false,
  leaseOwned: true,
  leaseUntil: null,
};

function setup(overrides: {
  claim?: () => Promise<LeaseJob | null>;
  state?: () => Promise<JobState | null>;
  renew?: () => Promise<boolean>;
  handler?: JobHandler;
  publish?: (result: WorkerResult) => Promise<void>;
}) {
  const published: WorkerResult[] = [];
  const runner = new JobRunner({
    core: {
      claim: overrides.claim ?? (() => Promise.resolve(job)),
      state: overrides.state ?? (() => Promise.resolve(owned)),
      renew: overrides.renew ?? (() => Promise.resolve(true)),
    },
    publisher: {
      publishResult: async (result) => {
        await overrides.publish?.(result);
        published.push(result);
      },
    },
    handlers: { 'site.build': overrides.handler ?? (() => Promise.resolve({ ok: true })) },
    workerId: 'sites-test',
    leaseSeconds: 60,
    renewSeconds: 20,
    newId: () => '0b8f6a3e-0000-4000-8000-000000000000',
  });
  return { runner, published };
}

const command = { jobId: JOB, kind: 'site.build' };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('JobRunner', () => {
  it('claims, runs and publishes a successful result under a worker-prefixed execution id', async () => {
    const { runner, published } = setup({});
    expect(await runner.handle(command, 'trace')).toBe('ack');
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      jobId: JOB,
      executionId: 'sites-test:0b8f6a3e-0000-4000-8000-000000000000',
      succeeded: true,
      result: { ok: true },
      traceParent: 'trace',
      messageType: 'worker.result.v1',
    });
  });

  it('rejects a kind it has no handler for, and a claimed job of another kind', async () => {
    expect(await setup({}).runner.handle({ jobId: JOB, kind: 'site.other' }, null)).toBe('reject');
    expect(
      await setup({ claim: () => Promise.resolve({ ...job, kind: 'site.purge' }) }).runner.handle(
        command,
        null,
      ),
    ).toBe('reject');
  });

  it('acknowledges a job another execution already finished, and requeues one it still holds', async () => {
    const finished = setup({
      claim: () => Promise.resolve(null),
      state: () => Promise.resolve({ ...owned, status: 'completed', leaseOwned: false }),
    });
    expect(await finished.runner.handle(command, null)).toBe('ack');
    expect(finished.published).toHaveLength(0);

    const running = setup({
      claim: () => Promise.resolve(null),
      state: () => Promise.resolve({ ...owned, leaseOwned: false }),
    });
    const pending = running.runner.handle(command, null);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toBe('requeue');
  });

  it('requeues when the claim itself fails', async () => {
    const { runner } = setup({ claim: () => Promise.reject(new Error('down')) });
    expect(await runner.handle(command, null)).toBe('requeue');
  });

  it('aborts the work and requeues without a result when the lease is lost', async () => {
    let aborted = false;
    const { runner, published } = setup({
      state: () => Promise.resolve({ ...owned, leaseOwned: false }),
      handler: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
    });
    const pending = runner.handle(command, null);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await pending).toBe('requeue');
    expect(aborted).toBe(true);
    expect(published).toHaveLength(0);
  });

  it('renews on each interval while the work runs', async () => {
    const renew = vi.fn(() => Promise.resolve(true));
    let finish: () => void = () => undefined;
    const { runner } = setup({
      renew,
      handler: () =>
        new Promise(
          (resolve) =>
            (finish = () => {
              resolve(null);
            }),
        ),
    });
    const pending = runner.handle(command, null);
    await vi.advanceTimersByTimeAsync(41_000);
    finish();
    expect(await pending).toBe('ack');
    expect(renew).toHaveBeenCalledTimes(2);
  });

  it('reports a requested cancellation as job_cancelled', async () => {
    const { runner, published } = setup({
      state: () => Promise.resolve({ ...owned, cancellationRequested: true }),
      handler: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    });
    const pending = runner.handle(command, null);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await pending).toBe('ack');
    expect(published[0]).toMatchObject({ succeeded: false, errorCode: 'job_cancelled' });
  });

  it('reports a handler error with its code, and falls back for an invalid code', async () => {
    const coded = setup({
      handler: () => Promise.reject(new JobError('site_body_withheld', 'a body was withheld')),
    });
    await coded.runner.handle(command, null);
    expect(coded.published[0]).toMatchObject({
      succeeded: false,
      retryable: false,
      errorCode: 'site_body_withheld',
      errorDetail: 'a body was withheld',
    });

    const bad = setup({ handler: () => Promise.reject(new JobError('has a space', 'x')) });
    await bad.runner.handle(command, null);
    expect(bad.published[0]).toMatchObject({ errorCode: 'worker_failed' });

    const unknown = setup({ handler: () => Promise.reject(new Error('secret internals')) });
    await unknown.runner.handle(command, null);
    expect(unknown.published[0]).toMatchObject({
      errorCode: 'worker_failed',
      errorDetail: 'The worker could not complete the job.',
    });
  });

  it('treats a 409 as lost only when Core no longer says the lease is owned', async () => {
    const refusal = () =>
      Promise.reject(new CoreResponseError(409, 'sites.build_closed', 'closed'));

    const stillOwned = setup({ handler: refusal });
    expect(await stillOwned.runner.handle(command, null)).toBe('ack');
    expect(stillOwned.published[0]).toMatchObject({ succeeded: false, errorCode: 'core_refused' });

    const lost = setup({
      handler: refusal,
      state: () => Promise.resolve({ ...owned, leaseOwned: false }),
    });
    expect(await lost.runner.handle(command, null)).toBe('requeue');
    expect(lost.published).toHaveLength(0);
  });

  it('requeues when the result cannot be published', async () => {
    const { runner } = setup({ publish: () => Promise.reject(new Error('unroutable')) });
    expect(await runner.handle(command, null)).toBe('requeue');
  });
});
