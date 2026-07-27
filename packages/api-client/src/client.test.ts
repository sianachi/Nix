import { HttpResponse, delay, http } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryTokenStore } from './auth.js';
import { createNixClient, type NixClient } from './client.js';
import { defineCommand, definePagedQuery, defineQuery } from './endpoints.js';
import { NixErrorCode, NixErrorKind } from './errors.js';
import { itemSchema, noContentSchema, type Item } from './schemas/index.js';
import { captureFailure } from './testing/failure.js';
import { TEST_BASE_URL, server, testUrl } from './testing/server.js';

const ITEM_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';

function itemPayload(title: string): Record<string, unknown> {
  return {
    id: ITEM_ID,
    workspaceId: WORKSPACE_ID,
    parentId: null,
    type: 'note',
    title,
    seq: 1000,
    lifecycleState: 'active',
    // The promoted field and the bag carry the same title, because the server sends both from one
    // value. A fixture where they disagreed would be a shape the API cannot produce, and somebody
    // would eventually write code against it.
    properties: { title },
    createdAt: '2026-07-26T09:30:00.000Z',
    updatedAt: '2026-07-26T09:30:00.000Z',
  };
}

const itemById = (id: string) =>
  defineQuery<Item>({
    operation: 'items.get',
    path: `/items/${id}`,
    schema: itemSchema,
    cacheKey: ['items', id],
  });

let clock: number;
let onParseError: ReturnType<typeof vi.fn>;
let client: NixClient;

beforeEach(() => {
  clock = 0;
  onParseError = vi.fn();
  client = createNixClient({
    baseUrl: TEST_BASE_URL,
    tokens: createInMemoryTokenStore({
      initialAccessToken: 'token',
      refresh: () => Promise.resolve(null),
    }),
    telemetry: { onParseError },
    cache: { now: () => clock, staleAfterMs: 1_000 },
  });
});

describe('reading a resource', () => {
  it('parses the response once at the boundary and hands back a frozen object', async () => {
    server.use(
      http.get(testUrl(`/items/${ITEM_ID}`), () => HttpResponse.json(itemPayload('Plan'))),
    );

    const item = await client.query(itemById(ITEM_ID));

    expect(item.title).toBe('Plan');
    expect(Object.isFrozen(item)).toBe(true);
  });

  it('makes one network call when several views ask for the same item at once', async () => {
    let calls = 0;
    server.use(
      http.get(testUrl(`/items/${ITEM_ID}`), async () => {
        calls += 1;
        await delay(10);
        return HttpResponse.json(itemPayload('Plan'));
      }),
    );

    const items = await Promise.all([
      client.query(itemById(ITEM_ID)),
      client.query(itemById(ITEM_ID)),
      client.query(itemById(ITEM_ID)),
      client.query(itemById(ITEM_ID)),
    ]);

    expect(calls).toBe(1);
    expect(items.map((item) => item.title)).toEqual(['Plan', 'Plan', 'Plan', 'Plan']);
  });

  it('serves the cached item immediately and refreshes it behind the caller once stale', async () => {
    let title = 'First';
    let calls = 0;
    server.use(
      http.get(testUrl(`/items/${ITEM_ID}`), () => {
        calls += 1;
        return HttpResponse.json(itemPayload(title));
      }),
    );

    await client.query(itemById(ITEM_ID));
    clock = 5_000;
    title = 'Second';
    const stale = await client.queryResult(itemById(ITEM_ID));

    expect(stale.servedFromCache).toBe(true);
    expect(stale.data.title).toBe('First');
    expect(stale.revalidation).not.toBeNull();

    await stale.revalidation;
    const refreshed = await client.query(itemById(ITEM_ID));

    expect(calls).toBe(2);
    expect(refreshed.title).toBe('Second');
  });

  it('cancels the in-flight request when the caller aborts and caches nothing from it', async () => {
    let calls = 0;
    server.use(
      http.get(testUrl(`/items/${ITEM_ID}`), async () => {
        calls += 1;
        await delay(50);
        return HttpResponse.json(itemPayload('Plan'));
      }),
    );
    const controller = new AbortController();

    const pending = captureFailure(client.query(itemById(ITEM_ID), { signal: controller.signal }));
    await delay(5);
    controller.abort();
    const error = await pending;

    expect(error.kind).toBe(NixErrorKind.Canceled);
    expect(error.code).toBe(NixErrorCode.Canceled);
    expect(client.cache.peek(['items', ITEM_ID])).toBeUndefined();

    // The abandoned flight leaves nothing behind: the next view loads afresh.
    const item = await client.query(itemById(ITEM_ID));

    expect(item.title).toBe('Plan');
    expect(calls).toBe(2);
  });

  it('reports a schema mismatch as telemetry and fails instead of returning a partial object', async () => {
    server.use(
      http.get(testUrl(`/items/${ITEM_ID}`), () =>
        HttpResponse.json({ ...itemPayload('Plan'), id: 'not-a-uuid' }),
      ),
    );

    const error = await captureFailure(client.query(itemById(ITEM_ID)));

    expect(error.kind).toBe(NixErrorKind.ResponseValidation);
    expect(error.code).toBe(NixErrorCode.ResponseValidation);
    expect(onParseError).toHaveBeenCalledTimes(1);
    expect(onParseError).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'items.get', status: 200 }),
    );
    expect(error.issues.map((issue) => issue.path)).toEqual(['id']);
    expect(client.cache.peek(['items', ITEM_ID])).toBeUndefined();
  });

  it('surfaces a problem details failure with its stable code and caches nothing', async () => {
    server.use(
      http.get(testUrl(`/items/${ITEM_ID}`), () =>
        HttpResponse.json(
          { title: 'Item not found', status: 404, code: 'item.not_found' },
          { status: 404, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );

    const error = await captureFailure(client.query(itemById(ITEM_ID)));

    expect(error.code).toBe('item.not_found');
    expect(client.cache.peek(['items', ITEM_ID])).toBeUndefined();
  });
});

describe('cursor pagination', () => {
  const children = definePagedQuery<Item>({
    operation: 'items.children',
    path: `/items/${ITEM_ID}/children`,
    itemSchema,
    pageSize: 2,
  });

  beforeEach(() => {
    server.use(
      http.get(testUrl(`/items/${ITEM_ID}/children`), ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        if (cursor === null) {
          return HttpResponse.json({
            items: [itemPayload('One'), itemPayload('Two')],
            nextCursor: 'page-2',
          });
        }
        return HttpResponse.json({ items: [itemPayload('Three')], nextCursor: null });
      }),
    );
  });

  it('walks every page as an async iterator until the cursor runs out', async () => {
    const titles: string[] = [];

    for await (const child of client.paginate(children)) titles.push(child.title);

    expect(titles).toEqual(['One', 'Two', 'Three']);
  });

  it('sends the page size and stops requesting pages when the consumer stops iterating', async () => {
    const searches: string[] = [];
    server.use(
      http.get(testUrl(`/items/${ITEM_ID}/children`), ({ request }) => {
        searches.push(new URL(request.url).search);
        return HttpResponse.json({
          items: [itemPayload('One'), itemPayload('Two')],
          nextCursor: 'page-2',
        });
      }),
    );

    for await (const child of client.paginate(children)) {
      expect(child.title).toBe('One');
      break;
    }

    expect(searches).toEqual(['?limit=2']);
  });
});

describe('commands', () => {
  it('marks the cache keys a successful command declares as stale', async () => {
    server.use(
      http.get(testUrl(`/items/${ITEM_ID}`), () => HttpResponse.json(itemPayload('Plan'))),
      http.patch(testUrl(`/items/${ITEM_ID}`), () => new HttpResponse(null, { status: 204 })),
    );
    await client.query(itemById(ITEM_ID));
    expect(client.cache.peek(['items', ITEM_ID])?.stale).toBe(false);

    await client.execute(
      defineCommand<undefined>({
        operation: 'items.rename',
        method: 'PATCH',
        path: `/items/${ITEM_ID}`,
        body: { title: 'Renamed' },
        schema: noContentSchema,
        invalidates: [['items']],
      }),
    );

    expect(client.cache.peek(['items', ITEM_ID])?.stale).toBe(true);
  });
});
