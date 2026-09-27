import { describe, expect, it } from 'vitest';

import { runtime, watchRuntime } from './pets.js';

const WORKSPACE_ID = 'a1000000-0000-4000-8000-000000000001';
const PET_ID = 'a2000000-0000-4000-8000-000000000002';

describe('the pets resource', () => {
  it('runtime is a POST that never carries after for the model to read', () => {
    expect(runtime({ operation: 'read', workspaceId: WORKSPACE_ID, petId: PET_ID })).toMatchObject(
      {
        kind: 'command',
        method: 'POST',
        path: '/api/v1/me/pets/runtime',
        body: { operation: 'read', workspaceId: WORKSPACE_ID, petId: PET_ID, after: 0 },
      },
    );
  });

  it('watchRuntime is a GET carrying workspaceId, petId and after as query parameters', () => {
    expect(
      watchRuntime({ workspaceId: WORKSPACE_ID, petId: PET_ID, mode: 'chat', after: 42 }),
    ).toMatchObject({
      kind: 'query',
      operation: 'pets.watchRuntime',
      path: '/api/v1/me/pets/runtime/watch',
      query: { workspaceId: WORKSPACE_ID, petId: PET_ID, mode: 'chat', after: 42 },
    });
  });

  it('watchRuntime defaults after to 0 and omits mode when not given', () => {
    expect(watchRuntime({ workspaceId: WORKSPACE_ID, petId: PET_ID })).toMatchObject({
      query: { workspaceId: WORKSPACE_ID, petId: PET_ID, after: 0 },
    });
    expect(
      watchRuntime({ workspaceId: WORKSPACE_ID, petId: PET_ID }).query,
    ).not.toHaveProperty('mode');
  });
});
