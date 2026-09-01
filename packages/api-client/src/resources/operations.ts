import { defineCommand, defineQuery, type CommandEndpoint, type QueryEndpoint } from '../endpoints.js';
import { noContentSchema } from '../schemas/index.js';
import { operationSchema, type Operation } from '../schemas/operations.js';
import type { NixClient } from '../client.js';

export const operationById = (operationId: string): QueryEndpoint<Operation> =>
  defineQuery({
    operation: 'operations.get',
    path: `/api/v1/operations/${operationId}`,
    schema: operationSchema,
    cacheKey: ['operations', operationId],
    staleAfterMs: 0,
  });

export const cancelOperation = (operationId: string): CommandEndpoint<undefined> =>
  defineCommand({
    operation: 'operations.cancel',
    method: 'POST',
    path: `/api/v1/operations/${operationId}/cancel`,
    schema: noContentSchema,
    invalidates: [['operations', operationId]],
  });

export async function waitForOperation(
  client: NixClient,
  operationId: string,
  options: {
    readonly signal?: AbortSignal;
    readonly pollIntervalMs?: number;
    readonly timeoutMs?: number;
  } = {},
): Promise<Operation> {
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  if (pollIntervalMs < 10 || timeoutMs < pollIntervalMs) {
    throw new RangeError('Operation polling limits are invalid.');
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    options.signal?.throwIfAborted();
    const operation = await client.query(operationById(operationId), {
      signal: options.signal,
      forceRefresh: true,
    });
    if (operation.status === 'completed') return operation;
    if (operation.status === 'failed' || operation.status === 'cancelled') {
      throw new Error(
        operation.errorDetail ??
          operation.errorCode ??
          (operation.status === 'cancelled'
            ? 'The operation was cancelled.'
            : 'The operation failed.'),
      );
    }
    if (Date.now() >= deadline) throw new Error('The operation did not finish before its deadline.');
    await delay(pollIntervalMs, options.signal);
  }
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(finish, milliseconds);
    signal?.addEventListener('abort', cancel, { once: true });

    function finish(): void {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }
    function cancel(): void {
      globalThis.clearTimeout(timer);
      const reason = signal?.reason as unknown;
      reject(reason instanceof Error ? reason : new Error('The operation wait was cancelled.'));
    }
  });
}
