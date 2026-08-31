export interface WorkerJob {
  readonly id: string;
  readonly kind: string;
  readonly status: 'queued' | 'running' | 'completed' | 'failed';
  readonly result: string | null;
  readonly errorCode: string | null;
  readonly errorDetail: string | null;
}

export interface ExportJobRequest {
  readonly workspaceId: string;
  readonly format: string;
  readonly sourceUrl: string;
  readonly destinationUrl: string;
  readonly idempotencyKey: string;
}

export interface ImportJobRequest {
  readonly workspaceId: string;
  readonly format: string;
  readonly sourceUrl: string;
  readonly rootId: string;
  readonly title: string;
  readonly idempotencyKey: string;
  readonly preview: true;
}

export interface WorkerJobs {
  createExport(token: string, request: ExportJobRequest, signal: AbortSignal): Promise<WorkerJob>;
  createImport(token: string, request: ImportJobRequest, signal: AbortSignal): Promise<WorkerJob>;
  cancel(token: string, jobId: string, signal: AbortSignal): Promise<void>;
  wait(token: string, jobId: string, signal: AbortSignal): Promise<WorkerJob>;
}

export function createWorkerJobs(options: {
  readonly coreBaseUrl: string;
  readonly internalSecret: string;
  readonly pollMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}): WorkerJobs {
  const doFetch = options.fetch ?? globalThis.fetch;
  const pollMs = options.pollMs ?? 250;

  async function call(token: string, path: string, init: RequestInit, signal: AbortSignal) {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    headers.set('x-nix-internal-secret', options.internalSecret);
    headers.set('accept', 'application/json');
    const response = await doFetch(`${options.coreBaseUrl}${path}`, {
      ...init,
      headers,
      signal,
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = record(body);
      throw new WorkerJobRefusal(
        response.status,
        text(detail.code) || 'worker_job_refused',
        text(detail.detail) || 'The export job was refused.',
      );
    }
    return parseJob(body);
  }

  return {
    createExport: (token, request, signal) =>
      call(
        token,
        '/internal/worker/jobs/exports',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
        },
        signal,
      ),
    createImport: (token, request, signal) =>
      call(
        token,
        '/internal/worker/jobs/imports',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
        },
        signal,
      ),
    async cancel(token, jobId, signal) {
      const headers = new Headers();
      headers.set('authorization', `Bearer ${token}`);
      headers.set('x-nix-internal-secret', options.internalSecret);
      const response = await doFetch(
        `${options.coreBaseUrl}/internal/worker/jobs/${jobId}/cancel`,
        {
          method: 'POST',
          headers,
          signal,
        },
      );
      if (!response.ok && response.status !== 404) {
        throw new WorkerJobRefusal(
          response.status,
          'worker_job_cancel_failed',
          'The worker job could not be cancelled.',
        );
      }
    },
    async wait(token, jobId, signal) {
      try {
        for (;;) {
          const job = await call(token, `/internal/worker/jobs/${jobId}`, {}, signal);
          if (job.status === 'completed' || job.status === 'failed') return job;
          await delay(pollMs, signal);
        }
      } catch (error) {
        if (signal.aborted) {
          await this.cancel(token, jobId, AbortSignal.timeout(5_000)).catch(() => undefined);
        }
        throw error;
      }
    },
  };
}

export class WorkerJobRefusal extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, detail: string) {
    super(detail);
    this.name = 'WorkerJobRefusal';
    this.status = status;
    this.code = code;
  }
}

function parseJob(value: unknown): WorkerJob {
  const body = record(value);
  const status = text(body.status);
  if (!['queued', 'running', 'completed', 'failed'].includes(status)) {
    throw new WorkerJobRefusal(
      502,
      'worker_job_contract_invalid',
      'Nix.Api returned an invalid worker job.',
    );
  }
  return {
    id: required(body.id),
    kind: required(body.kind),
    status: status as WorkerJob['status'],
    result: nullable(body.result),
    errorCode: nullable(body.errorCode),
    errorDetail: nullable(body.errorDetail),
  };
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('Worker job wait was cancelled.', { cause: signal.reason }));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function required(value: unknown): string {
  const result = text(value);
  if (result === '')
    throw new WorkerJobRefusal(
      502,
      'worker_job_contract_invalid',
      'Nix.Api returned an invalid worker job.',
    );
  return result;
}
function nullable(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
