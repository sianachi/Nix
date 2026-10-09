import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { createInMemoryTokenStore } from '../auth.js';
import { createNixClient, type NixClient } from '../client.js';
import { isNixApiError } from '../errors.js';
import { server, TEST_BASE_URL, testUrl } from '../testing/server.js';
import { aggregateWorkspaceQuery, runWorkspaceQuery } from './workspace-query.js';

const WORKSPACE_ID = 'c3333333-3333-4333-8333-333333333333';
const FOLDER_ID = 'a1111111-1111-4111-8111-111111111111';

const row = {
  id: 'b2222222-2222-4222-8222-222222222222',
  workspaceId: WORKSPACE_ID,
  containerId: FOLDER_ID,
  containerTitle: 'Work',
  title: 'Ship it',
  type: 'task',
  properties: { status: 'Doing' },
  group: 'Doing',
};

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

describe('workspace query', () => {
  it('posts the whole rule shape, nulls for what was not asked, and parses grouped rows', async () => {
    let sent: unknown = null;
    server.use(
      http.post(testUrl(`/api/v1/workspaces/${WORKSPACE_ID}/query`), async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({
          workspaceId: WORKSPACE_ID,
          today: '2026-08-15',
          results: [row],
          limit: 100,
          truncated: false,
          groupBy: 'status',
          groups: [{ key: 'Doing', label: 'Doing', count: 1 }],
        });
      }),
    );

    const result = await client.execute(
      runWorkspaceQuery(WORKSPACE_ID, {
        scope: { parentId: FOLDER_ID },
        filters: [
          { property: '$type', operator: 'equals', value: 'task' },
          {
            property: null,
            operator: null,
            value: null,
            any: [{ property: 'status', operator: 'equals', value: 'Doing', any: null }],
          },
        ],
        groupBy: { property: 'status', order: ['Todo', 'Doing'] },
        today: '2026-08-15',
      }),
    );

    expect(sent).toEqual({
      scope: { parentId: FOLDER_ID, descendants: null },
      preset: null,
      filters: [
        { property: '$type', operator: 'equals', value: 'task' },
        {
          property: null,
          operator: null,
          value: null,
          any: [{ property: 'status', operator: 'equals', value: 'Doing', any: null }],
        },
      ],
      groupBy: { property: 'status', order: ['Todo', 'Doing'] },
      today: '2026-08-15',
      sort: null,
      limit: null,
    });
    expect(result.results[0]?.group).toBe('Doing');
    expect(result.groups[0]?.count).toBe(1);
  });

  it('surfaces a hidden scope container as the item read does', async () => {
    server.use(
      http.post(testUrl(`/api/v1/workspaces/${WORKSPACE_ID}/query`), () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Request refused',
            status: 404,
            code: 'items.not_found',
            detail: `No item ${FOLDER_ID} is visible.`,
          },
          { status: 404, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );

    const error: unknown = await client
      .execute(runWorkspaceQuery(WORKSPACE_ID, { scope: { parentId: FOLDER_ID } }))
      .catch((reason: unknown) => reason);

    expect(isNixApiError(error) && error.code).toBe('items.not_found');
  });
});

describe('workspace aggregate', () => {
  it('posts the fold and parses totals with what was skipped', async () => {
    let sent: unknown = null;
    server.use(
      http.post(
        testUrl(`/api/v1/workspaces/${WORKSPACE_ID}/query/aggregate`),
        async ({ request }) => {
          sent = await request.json();
          return HttpResponse.json({
            workspaceId: WORKSPACE_ID,
            today: null,
            function: 'sum',
            property: 'amount',
            groupBy: null,
            groups: [],
            total: 42.5,
            count: 4,
            skipped: 1,
            groupCount: 1,
            truncated: false,
          });
        },
      ),
    );

    const result = await client.execute(
      aggregateWorkspaceQuery(WORKSPACE_ID, { aggregate: { function: 'sum', property: 'amount' } }),
    );

    expect(sent).toEqual({
      scope: null,
      preset: null,
      filters: null,
      groupBy: null,
      today: null,
      aggregate: { function: 'sum', property: 'amount' },
    });
    expect(result.total).toBe(42.5);
    expect(result.skipped).toBe(1);
  });
});
