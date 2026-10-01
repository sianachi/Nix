import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { createInMemoryTokenStore } from '../auth.js';
import { createNixClient, type NixClient } from '../client.js';
import { isNixApiError } from '../errors.js';
import { server, TEST_BASE_URL, testUrl } from '../testing/server.js';
import { findMentions, listRelatedItems } from './suggestions.js';

const ITEM_ID = 'a1111111-1111-4111-8111-111111111111';

const hit = {
  id: 'b2222222-2222-4222-8222-222222222222',
  workspaceId: 'c3333333-3333-4333-8333-333333333333',
  type: 'note',
  title: 'Project Atlas',
  parentId: null,
  updatedAt: '2026-09-01T12:00:00+00:00',
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

describe('related items', () => {
  it('reads the co-citations of an item with the requested limit', async () => {
    let limit: string | null = null;
    server.use(
      http.get(testUrl(`/api/v1/items/${ITEM_ID}/related`), ({ request }) => {
        limit = new URL(request.url).searchParams.get('limit');
        return HttpResponse.json({
          related: [{ item: hit, sharedSources: 2 }],
          limit: 5,
          truncated: false,
        });
      }),
    );

    const result = await client.query(listRelatedItems(ITEM_ID, 5));

    expect(limit).toBe('5');
    expect(result.related[0]?.item.parentId).toBeNull();
    expect(result.related[0]?.sharedSources).toBe(2);
  });
});

describe('mentions', () => {
  it('posts the passage and parses the matches', async () => {
    let sent: unknown = null;
    server.use(
      http.post(testUrl('/api/v1/search/mentions'), async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({
          mentions: [{ item: hit, phrase: 'Project Atlas' }],
          truncated: false,
        });
      }),
    );

    const result = await client.execute(
      findMentions({
        text: 'Notes on Project Atlas.',
        workspaceId: hit.workspaceId,
        excludeIds: [ITEM_ID],
      }),
    );

    expect(sent).toEqual({
      text: 'Notes on Project Atlas.',
      workspaceId: hit.workspaceId,
      excludeIds: [ITEM_ID],
    });
    expect(result.mentions[0]?.phrase).toBe('Project Atlas');
    expect(result.mentions[0]?.item.updatedAt).toBe(hit.updatedAt);
  });

  it('surfaces an oversized passage as its stable code', async () => {
    server.use(
      http.post(testUrl('/api/v1/search/mentions'), () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Request refused',
            status: 400,
            code: 'search.mention_text_too_long',
            detail: 'Too long.',
          },
          { status: 400, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    );

    const failure = await client
      .execute(findMentions({ text: 'x', workspaceId: hit.workspaceId }))
      .catch((reason: unknown) => reason);

    expect(isNixApiError(failure) && failure.code).toBe('search.mention_text_too_long');
  });

  it('sends an empty exclusion list when none is given', async () => {
    let sent: unknown = null;
    server.use(
      http.post(testUrl('/api/v1/search/mentions'), async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({ mentions: [], truncated: false });
      }),
    );

    await client.execute(findMentions({ text: 'Atlas', workspaceId: hit.workspaceId }));

    expect(sent).toEqual({ text: 'Atlas', workspaceId: hit.workspaceId, excludeIds: [] });
  });
});
