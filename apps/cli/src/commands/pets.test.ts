import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { petCommand } from './pets.ts';

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
describe('pet commands', () => {
  it('uses an explicit interactive token without storing it or widening PAT permissions', async () => {
    let payload: unknown;
    server.use(
      http.post('http://nix.test/api/v1/me/pets/runtime', async ({ request }) => {
        expect(request.headers.get('authorization')).toBe('Bearer ephemeral-session');
        payload = await request.json();
        return HttpResponse.json({
          provider: 'chatgpt',
          status: 'connected',
          reason: 'Connected',
          canConnect: false,
        });
      }),
    );
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await petCommand(
      undefined,
      'send',
      {
        apiUrl: 'http://nix.test',
        workspace: '11111111-1111-4111-8111-111111111111',
        pet: '22222222-2222-4222-8222-222222222222',
        message: 'Make a plan',
        workspaceTools: true,
        model: 'account-model',
      },
      { json: true, isTty: false },
      { env: { NIX_SESSION_TOKEN: 'ephemeral-session' } },
    );
    expect(payload).toMatchObject({
      operation: 'send',
      text: 'Make a plan',
      workspaceAccess: true,
      model: 'account-model',
    });
    expect(output).toHaveBeenCalled();
  });
  it('rejects unknown operations before contacting the service', async () => {
    await expect(petCommand(undefined, 'exec', {}, { json: true, isTty: false })).rejects.toThrow(
      'Choose a pet operation',
    );
  });
});
