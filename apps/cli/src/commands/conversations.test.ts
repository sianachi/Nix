import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { http } from 'msw';
import { setupServer } from 'msw/node';
import { openSession } from '../session.ts';
import { createWorkspaceMcpServer } from '../mcp.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  executeCreateConversation,
  executeConfigureConversation,
  executeGetConversation,
  executeConversationMessages,
  executeSendConversation,
  executeWatchConversation,
  executeCancelConversation,
  executeConversationSources,
  parseConversationInteger,
} from './conversations.ts';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const ITEM = '11111111-1111-4111-8111-111111111111';
const PET = '33333333-3333-4333-8333-333333333333';
const REQUEST = '44444444-4444-4444-8444-444444444444';
const conversation = {
  itemId: ITEM,
  workspaceId: WORKSPACE,
  title: 'Priorities',
  sourceWorkspaceIds: [WORKSPACE],
  petId: PET,
  revision: 4,
  canSend: true,
  canEdit: true,
  turn: null,
};
const input = { title: 'Priorities', parentId: null, sourceWorkspaceIds: [WORKSPACE], petId: PET };
const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterAll(() => {
  server.close();
});
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});

function sessionFor(handler: (url: URL, init?: { method: string; body?: string }) => Response) {
  server.use(
    http.all('http://nix.test/*', async ({ request }) =>
      handler(new URL(request.url), {
        method: request.method,
        ...(request.method === 'GET' ? {} : { body: await request.text() }),
      }),
    ),
  );
  return openSession({
    profile: { apiUrl: 'http://nix.test', token: '' },
    bearerToken: 'local-session',
  });
}

describe('durable chat commands', () => {
  it('creates and imports only the explicit destination, sources and visible transcript', async () => {
    const requests: unknown[] = [];
    const session = sessionFor((url, init) => {
      requests.push({
        path: url.pathname,
        method: init?.method,
        body: JSON.parse(init?.body ?? 'null') as unknown,
      });
      return Response.json(conversation);
    });
    expect(await executeCreateConversation(session, WORKSPACE, input)).toEqual(conversation);
    const transcript = {
      ...input,
      messages: [{ role: 'user' as const, text: 'Compare priorities' }],
    };
    await executeCreateConversation(session, WORKSPACE, transcript, true);
    expect(requests).toEqual([
      { path: `/api/v1/workspaces/${WORKSPACE}/conversations`, method: 'POST', body: input },
      {
        path: `/api/v1/workspaces/${WORKSPACE}/conversations/import`,
        method: 'POST',
        body: transcript,
      },
    ]);
  });
  it('configures an existing note with explicit sources and pet and preserves Core schema refusals', async () => {
    const requests: unknown[] = [];
    let compatible = true;
    const session = sessionFor((url, init) => {
      const body: unknown = JSON.parse(init?.body ?? 'null');
      requests.push({ path: url.pathname, method: init?.method, body });
      return compatible
        ? Response.json(conversation)
        : Response.json(
            {
              title: 'Invalid',
              status: 400,
              code: 'conversation.incompatible_schema',
              detail: 'Add compatible message fields.',
            },
            { status: 400, headers: { 'Content-Type': 'application/problem+json' } },
          );
    });
    expect(
      await executeConfigureConversation(session, ITEM, {
        sourceWorkspaceIds: [WORKSPACE],
        petId: PET,
      }),
    ).toEqual(conversation);
    expect(requests).toEqual([
      {
        path: `/api/v1/conversations/${ITEM}/configure`,
        method: 'POST',
        body: { sourceWorkspaceIds: [WORKSPACE], petId: PET },
      },
    ]);
    compatible = false;
    await expect(
      executeConfigureConversation(session, ITEM, { sourceWorkspaceIds: [WORKSPACE], petId: PET }),
    ).rejects.toMatchObject({ status: 400, code: 'conversation.incompatible_schema' });
  });
  it('reads messages with the pagination cursor and refreshes watch snapshots', async () => {
    const requests: string[] = [];
    const session = sessionFor((url) => {
      requests.push(url.pathname + url.search);
      return Response.json(
        url.pathname.endsWith('/messages')
          ? {
              items: [
                {
                  id: REQUEST,
                  role: 'assistant',
                  seq: '1',
                  text: 'One priority',
                  createdAt: '2026-10-15T12:00:00Z',
                  authorId: null,
                },
              ],
              nextCursor: '51',
            }
          : conversation,
      );
    });
    expect(await executeGetConversation(session, ITEM)).toEqual(conversation);
    expect(
      (await executeConversationMessages(session, ITEM, { cursor: '1', limit: 50 })).items[0]?.text,
    ).toBe('One priority');
    await executeWatchConversation(session, ITEM, 3);
    await executeWatchConversation(session, ITEM, 3);
    expect(requests).toEqual([
      `/api/v1/conversations/${ITEM}`,
      `/api/v1/conversations/${ITEM}/messages?cursor=1&limit=50`,
      `/api/v1/conversations/${ITEM}/watch?after=3`,
      `/api/v1/conversations/${ITEM}/watch?after=3`,
    ]);
  });
  it('preserves retry identity and revision fences and cancels without deleting', async () => {
    const requests: unknown[] = [];
    const session = sessionFor((url, init) => {
      requests.push({
        path: url.pathname,
        method: init?.method,
        body: JSON.parse(init?.body ?? 'null') as unknown,
      });
      return Response.json(conversation);
    });
    await executeSendConversation(session, ITEM, {
      requestId: REQUEST,
      text: 'Compare',
      model: 'chosen',
    });
    await executeConversationSources(session, ITEM, [WORKSPACE], 4);
    await executeCancelConversation(session, ITEM);
    expect(requests).toEqual([
      {
        path: `/api/v1/conversations/${ITEM}/turns`,
        method: 'POST',
        body: { requestId: REQUEST, text: 'Compare', model: 'chosen' },
      },
      {
        path: `/api/v1/conversations/${ITEM}/sources`,
        method: 'PUT',
        body: { sourceWorkspaceIds: [WORKSPACE], expectedRevision: 4 },
      },
      { path: `/api/v1/conversations/${ITEM}/cancel`, method: 'POST', body: {} },
    ]);
  });
  it('preserves Core source-access refusals', async () => {
    const session = sessionFor(() =>
      Response.json(
        {
          title: 'Forbidden',
          status: 403,
          detail: 'Remove unavailable source workspaces.',
          code: 'conversation.source_unavailable',
        },
        { status: 403, headers: { 'Content-Type': 'application/problem+json' } },
      ),
    );
    await expect(
      executeSendConversation(session, ITEM, { requestId: REQUEST, text: 'Compare' }),
    ).rejects.toMatchObject({ status: 403, code: 'conversation.source_unavailable' });
  });
  it.each(['', '-1', '1.1', 'Infinity', '9007199254740992'])(
    'rejects invalid revision %s',
    (value) => {
      expect(() => parseConversationInteger(value)).toThrow();
    },
  );
  it('requires transcript-sharing confirmation in MCP before any request', async () => {
    let requests = 0;
    const server = await createWorkspaceMcpServer({
      resolve: () =>
        Promise.resolve(
          sessionFor(() => {
            requests++;
            return Response.json(conversation);
          }),
        ),
    });
    const client = new Client({ name: 'chat-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      const result = await client.callTool({
        name: 'import_chat_note',
        arguments: {
          workspaceId: WORKSPACE,
          conversation: { ...input, messages: [{ role: 'assistant', text: 'Private insight' }] },
        },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('confirm sharing');
      expect(requests).toBe(0);
      const saved = await client.callTool({
        name: 'import_chat_note',
        arguments: {
          workspaceId: WORKSPACE,
          conversation: { ...input, messages: [{ role: 'assistant', text: 'Private insight' }] },
          confirmSharing: true,
        },
      });
      expect(saved.isError).not.toBe(true);
      expect(JSON.stringify(saved)).toContain(ITEM);
      expect(requests).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
