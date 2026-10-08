import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { chatCaseSchema } from '@nix/structure-spec';
import { openSession } from '../session.ts';
import {
  runChatSuite,
  substituteDates,
  type ChatEvalRuntime,
  type ChatFixture,
} from './pet-eval-chat.ts';

const CORE = 'http://nix.eval.test';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const PET = '33333333-3333-4333-8333-333333333333';
const ROOT = '44444444-4444-4444-8444-444444444444';
const TASKS = '55555555-5555-4555-8555-555555555555';
const DENTIST = '66666666-6666-4666-8666-666666666666';
const OUTSIDE = '77777777-7777-4777-8777-777777777777';

const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => {
  server.close();
});

const fixture: ChatFixture = {
  rootId: ROOT,
  nodes: new Map([
    ['home', ROOT],
    ['tasks', TASKS],
    ['task-dentist', DENTIST],
  ]),
};

function item(id: string, parentId: string | null, title: string, properties: Record<string, unknown> = {}) {
  return {
    id,
    workspaceId: WORKSPACE,
    parentId,
    title,
    type: 'note',
    hasChildren: false,
    seq: 1000,
    lifecycleState: 'active',
    properties,
    createdAt: '2026-10-08T00:00:00.000Z',
    updatedAt: '2026-10-08T00:00:00.000Z',
  };
}

function toolCall(id: string, args: Record<string, unknown>) {
  return {
    id,
    arguments: JSON.stringify({
      itemId: '',
      parentId: '',
      title: '',
      markdown: '',
      query: '',
      propertiesJson: '',
      specJson: '',
      ...args,
    }),
    status: 'pending',
    result: '',
    claimId: '',
  };
}

function connection(extra: Record<string, unknown> = {}) {
  return { provider: 'chatgpt', status: 'connected', reason: '', canConnect: false, ...extra };
}

/** A runtime that offers `tools` one read at a time, then finishes with `answer`. */
function scriptedRuntime(tools: ReturnType<typeof toolCall>[], answer: string) {
  const calls: Record<string, unknown>[] = [];
  const decided = new Map<string, { status: string; claimId: string; result: string }>();
  server.use(
    http.post(`${CORE}/api/v1/me/pets/runtime`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      calls.push(body);
      const current = () =>
        tools.map((tool) => ({ ...tool, ...(decided.get(tool.id) ?? {}) }));
      if (body.operation === 'tool_claim') {
        decided.set(String(body.toolId), { status: 'claimed', claimId: String(body.requestId), result: '' });
        return HttpResponse.json(connection({ state: 'thinking', tools: current() }));
      }
      if (body.operation === 'tool_result') {
        decided.set(String(body.toolId), {
          status: body.toolSuccess ? 'completed' : 'failed',
          claimId: String(body.requestId),
          result: String(body.toolResult),
        });
        return HttpResponse.json(connection({ state: 'thinking', tools: current() }));
      }
      if (body.operation === 'read') {
        const pending = tools.some((tool) => (decided.get(tool.id)?.status ?? 'pending') === 'pending');
        return HttpResponse.json(
          connection({
            state: pending ? 'thinking' : 'success',
            tools: current(),
            messages: pending ? [] : [{ id: 'a-1', role: 'assistant', text: answer }],
          }),
        );
      }
      return HttpResponse.json(connection({ state: 'thinking' }));
    }),
  );
  return calls;
}

function runner(): ChatEvalRuntime {
  const session = openSession({
    profile: { apiUrl: CORE, token: 'pat' },
    bearerToken: 'session',
  });
  return {
    session,
    sleep: () => Promise.resolve(),
    today: () => '2026-10-08',
    seed: () => Promise.resolve(fixture),
    teardown: () => Promise.resolve(),
  };
}

describe('pet eval chat', () => {
  it('substitutes relative dates in the fixture', () => {
    expect(substituteDates('{today} {today+3} {today-2}', '2026-10-08')).toBe(
      '2026-10-08 2026-10-11 2026-10-06',
    );
  });

  it('runs a read on its own, keeps a write declined without --allow-writes, and scores the answer', async () => {
    const calls = scriptedRuntime(
      [
        toolCall('t-1', { operation: 'list_items', parentId: TASKS }),
        toolCall('t-2', { operation: 'set_properties', itemId: DENTIST, propertiesJson: '{"completion":true}' }),
      ],
      'Pay rent and Call dentist are on the board.',
    );
    server.use(
      http.get(`${CORE}/api/v1/items/${TASKS}`, () => HttpResponse.json(item(TASKS, ROOT, 'Tasks'))),
      // nix_list_items reads the container's schema to key each row's values.
      http.get(`${CORE}/api/v1/items/${TASKS}/schema`, () =>
        HttpResponse.json({ properties: [], declared: [], inherit: true }),
      ),
      http.get(`${CORE}/api/v1/workspaces/${WORKSPACE}/items`, () =>
        HttpResponse.json({ items: [item(DENTIST, TASKS, 'Call dentist')], nextCursor: null }),
      ),
    );
    const chatCase = chatCaseSchema.parse({
      id: 'read-board',
      prompt: 'What is on {node:tasks}?',
      tools: { require: ['list_items|search'], forbid: ['create_note'], max: 6 },
      answer: 'Pay rent',
    });
    const [result] = await runChatSuite([chatCase], { suite: 'chat', workspace: WORKSPACE, pet: PET }, runner());
    expect(result).toMatchObject({ id: 'read-board', outcome: 'done', pass: true });
    expect(result?.tools).toEqual([
      expect.objectContaining({ operation: 'list_items', decision: 'ran', success: true }),
      expect.objectContaining({ operation: 'set_properties', decision: 'declined', reason: 'writes are not allowed in this run' }),
    ]);
    expect(calls.find((call) => call.operation === 'send')).toMatchObject({
      text: 'What is on Tasks?',
      mode: 'chat',
      workspaceAccess: true,
    });
    expect(calls.filter((call) => call.operation === 'reset')).toHaveLength(2);
  });

  it('declines a write outside the fixture and an always-ask write even with --allow-writes, and fails on the assertion', async () => {
    scriptedRuntime(
      [
        toolCall('t-1', { operation: 'rename_item', itemId: OUTSIDE, title: 'Elsewhere' }),
        toolCall('t-2', { operation: 'trash_item', itemId: DENTIST }),
      ],
      'Done.',
    );
    server.use(
      http.get(`${CORE}/api/v1/items/${OUTSIDE}`, () => HttpResponse.json(item(OUTSIDE, null, 'Elsewhere'))),
      http.get(`${CORE}/api/v1/items/${DENTIST}`, () => HttpResponse.json(item(DENTIST, TASKS, 'Call dentist', { completion: false }))),
    );
    const chatCase = chatCaseSchema.parse({
      id: 'complete-task',
      prompt: 'Mark it done.',
      tools: { require: ['set_properties'], forbid: ['trash_item'], max: 6 },
      asserts: [{ kind: 'value', item: 'task-dentist', key: 'completion', truthy: true }],
    });
    const [result] = await runChatSuite(
      [chatCase],
      { suite: 'chat', workspace: WORKSPACE, pet: PET, allowWrites: true },
      runner(),
    );
    expect(result?.tools).toEqual([
      expect.objectContaining({ operation: 'rename_item', decision: 'declined', reason: 'the target is outside the fixture' }),
      expect.objectContaining({ operation: 'trash_item', decision: 'declined', reason: 'trash_item always asks' }),
    ]);
    expect(result?.pass).toBe(false);
    expect(result?.failures).toEqual([
      'never attempted set_properties',
      'attempted forbidden trash_item',
      'task-dentist.completion is false, expected truthy',
    ]);
  });

  it('stops at the tool budget and reports it', async () => {
    scriptedRuntime(
      [
        toolCall('t-1', { operation: 'search', query: 'a' }),
        toolCall('t-2', { operation: 'search', query: 'b' }),
      ],
      'never reached',
    );
    server.use(
      http.get(`${CORE}/api/v1/search`, () => HttpResponse.json({ results: [], truncated: false })),
    );
    const chatCase = chatCaseSchema.parse({ id: 'budget', prompt: 'x', tools: { max: 1 } });
    const [result] = await runChatSuite([chatCase], { suite: 'chat', workspace: WORKSPACE, pet: PET }, runner());
    expect(result).toMatchObject({ outcome: 'tool_limit', pass: false });
    expect(result?.failures).toContain('outcome tool_limit');
  });
});
