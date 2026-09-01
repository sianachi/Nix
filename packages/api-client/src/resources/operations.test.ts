import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { createInMemoryTokenStore } from '../auth.js';
import { createNixClient, type NixClient } from '../client.js';
import { server, TEST_BASE_URL, testUrl } from '../testing/server.js';
import { waitForOperation } from './operations.js';

const OPERATION_ID = 'a1111111-1111-4111-8111-111111111111';

function operation(status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled') {
  return {
    id: OPERATION_ID,
    kind: 'file.inspect',
    status,
    result: status === 'completed' ? { itemId: 'item' } : null,
    errorCode: status === 'failed' ? 'files.invalid' : null,
    errorDetail: status === 'failed' ? 'The file is invalid.' : null,
    attempts: status === 'queued' ? 0 : 1,
    cancellationRequested: false,
    createdAt: '2026-09-01T00:00:00Z',
    completedAt: status === 'completed' || status === 'failed' ? '2026-09-01T00:00:01Z' : null,
  };
}

let client: NixClient;

beforeEach(() => {
  client = createNixClient({
    baseUrl: TEST_BASE_URL,
    tokens: createInMemoryTokenStore({
      initialAccessToken: 'token',
      refresh: () => Promise.resolve(null),
    }),
  });
});

describe('waiting for a durable operation', () => {
  it('polls fresh state until the worker completes', async () => {
    let reads = 0;
    server.use(
      http.get(testUrl(`/api/v1/operations/${OPERATION_ID}`), () => {
        reads += 1;
        return HttpResponse.json(operation(reads === 1 ? 'running' : 'completed'));
      }),
    );

    const result = await waitForOperation(client, OPERATION_ID, {
      pollIntervalMs: 10,
      timeoutMs: 100,
    });

    expect(result.status).toBe('completed');
    expect(reads).toBe(2);
  });

  it('surfaces the durable worker failure detail', async () => {
    server.use(
      http.get(testUrl(`/api/v1/operations/${OPERATION_ID}`), () =>
        HttpResponse.json(operation('failed')),
      ),
    );

    await expect(
      waitForOperation(client, OPERATION_ID, { pollIntervalMs: 10, timeoutMs: 100 }),
    ).rejects.toThrow('The file is invalid.');
  });

  it('stops a pending wait when its caller aborts', async () => {
    server.use(
      http.get(testUrl(`/api/v1/operations/${OPERATION_ID}`), () =>
        HttpResponse.json(operation('running')),
      ),
    );
    const controller = new AbortController();
    const waiting = waitForOperation(client, OPERATION_ID, {
      signal: controller.signal,
      pollIntervalMs: 20,
      timeoutMs: 200,
    });
    controller.abort(new Error('stop'));

    await expect(waiting).rejects.toThrow('cancelled by the caller');
  });
});
