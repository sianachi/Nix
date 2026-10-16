import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveProfile } from '../config.ts';
import { outputOptions } from '../output.ts';
import { runMyDay } from './my-day.ts';

const API = 'http://nix.test';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';

const server = setupServer(
  http.post(`${API}/public/v1/auth/token`, () =>
    HttpResponse.json({ accessToken: 'jwt-1', tokenType: 'Bearer', expiresInSeconds: 600 }),
  ),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

describe('nixctl my-day', () => {
  it('prints the projection with its coverage intact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nixctl-my-day-'));
    const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: dir };
    await saveProfile('default', { apiUrl: API, token: 'nixpat_abc' }, { makeDefault: true, env });
    server.use(
      http.get(`${API}/api/v1/workspaces/${WORKSPACE}/my-day`, () =>
        HttpResponse.json({
          workspaceId: WORKSPACE,
          evaluatedAt: '2026-10-16T12:00:00+00:00',
          taskDay: '2026-10-16',
          taskTimezone: 'UTC',
          tasks: {
            rows: [],
            coverage: { kind: 'partial', reasons: [{ code: 'candidate_limit', omitted: null }] },
            limits: { candidates: 200, rows: 100 },
          },
          habits: {
            rows: [],
            coverage: { kind: 'complete', reasons: [] },
            limits: { candidates: 24, rows: 24 },
          },
        }),
      ),
    );

    const lines: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        lines.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
        return true;
      });
    try {
      await runMyDay('default', WORKSPACE, outputOptions(true, { isTTY: false }), { env });
    } finally {
      spy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }

    const printed = JSON.parse(lines.join('')) as {
      taskDay: string;
      tasks: { coverage: { kind: string; reasons: { code: string; omitted: number | null }[] } };
    };
    expect(printed.taskDay).toBe('2026-10-16');
    expect(printed.tasks.coverage).toEqual({
      kind: 'partial',
      reasons: [{ code: 'candidate_limit', omitted: null }],
    });
  });
});
