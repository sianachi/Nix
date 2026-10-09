import { describe, expect, it } from 'vitest';

import { runtime, watchRuntime } from './pets.js';

const WORKSPACE_ID = 'a1000000-0000-4000-8000-000000000001';
const PET_ID = 'a2000000-0000-4000-8000-000000000002';

describe('the pets resource', () => {
  it('runtime is a POST whose body never carries after; only watchRuntime reads it', () => {
    const built = runtime({ operation: 'read', workspaceId: WORKSPACE_ID, petId: PET_ID });
    expect(built).toMatchObject({
      kind: 'command',
      method: 'POST',
      path: '/api/v1/me/pets/runtime',
      body: { operation: 'read', workspaceId: WORKSPACE_ID, petId: PET_ID },
    });
    expect(built.body).not.toHaveProperty('after');
  });

  it('runtime sends the owner date, zone and workspace map, defaulting each to empty', () => {
    const sent = runtime({
      operation: 'send',
      workspaceId: WORKSPACE_ID,
      petId: PET_ID,
      today: '2026-10-09',
      timeZone: 'Europe/London',
      workspaceMap: [
        { id: WORKSPACE_ID, title: 'Tasks', type: 'note', viewKinds: ['board'] },
        { id: PET_ID, title: 'Log', type: 'note' },
      ],
    });
    expect(sent.body).toMatchObject({
      today: '2026-10-09',
      timeZone: 'Europe/London',
      workspaceMap: [
        { id: WORKSPACE_ID, title: 'Tasks', type: 'note', viewKinds: ['board'] },
        { id: PET_ID, title: 'Log', type: 'note', viewKinds: null },
      ],
    });
    expect(runtime({ operation: 'read' }).body).toMatchObject({
      today: '',
      timeZone: '',
      workspaceMap: null,
    });
  });

  it('carries the locked-content mark both ways, defaulting to unmarked', async () => {
    const { petConnectionSchema } = await import('../schemas/pets.js');
    expect(runtime({ operation: 'tool_result', toolLockedContent: true }).body).toMatchObject({
      toolLockedContent: true,
    });
    expect(runtime({ operation: 'read' }).body).toMatchObject({ toolLockedContent: false });
    const base = { provider: 'chatgpt', status: 'connected', reason: '', canConnect: false };
    expect(petConnectionSchema.parse(base).lockedRead).toBe(false);
    expect(petConnectionSchema.parse({ ...base, lockedRead: true }).lockedRead).toBe(true);
  });

  it('a message parses without any actions member', async () => {
    const { petMessageSchema } = await import('../schemas/pets.js');
    expect(petMessageSchema.parse({ id: 'm', role: 'assistant', text: 'Hi', actions: [] })).toEqual(
      {
        id: 'm',
        role: 'assistant',
        text: 'Hi',
      },
    );
  });

  it('watchRuntime is a GET carrying workspaceId, petId and after as query parameters', () => {
    expect(
      watchRuntime({ workspaceId: WORKSPACE_ID, petId: PET_ID, mode: 'chat', after: 42 }),
    ).toMatchObject({
      kind: 'query',
      operation: 'pets.watchRuntime',
      timeoutMs: 35_000,
      path: '/api/v1/me/pets/runtime/watch',
      query: { workspaceId: WORKSPACE_ID, petId: PET_ID, mode: 'chat', after: 42 },
    });
  });

  it('watchRuntime defaults after to 0 and omits mode when not given', () => {
    expect(watchRuntime({ workspaceId: WORKSPACE_ID, petId: PET_ID })).toMatchObject({
      query: { workspaceId: WORKSPACE_ID, petId: PET_ID, after: 0 },
    });
    expect(watchRuntime({ workspaceId: WORKSPACE_ID, petId: PET_ID }).query).not.toHaveProperty(
      'mode',
    );
  });
});
