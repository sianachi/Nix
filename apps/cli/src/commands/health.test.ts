import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { outputOptions } from '../output.ts';
import { readHealth } from './health.ts';

const API = 'http://nix.test';
const STATUS = { service: 'nix-api', version: '1.0.0', utcNow: '2026-10-09T12:30:00Z' };
const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  server.resetHandlers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
afterAll(() => {
  server.close();
});

function capture() {
  const lines: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    return true;
  });
  return lines;
}

function healthy() {
  server.use(
    http.get(`${API}/healthz`, () => HttpResponse.json({ status: 'healthy' })),
    http.get(`${API}/api/v1/health/status`, () => HttpResponse.json(STATUS)),
  );
}

describe('public Core health', () => {
  it('reports real liveness and identity without credentials or a token exchange', async () => {
    vi.stubEnv('NIX_SESSION_TOKEN', 'must-not-be-sent');
    vi.stubEnv('NIX_API_URL', 'http://must-not-be-used.test');
    const requested: string[] = [];
    server.use(
      http.get(`${API}/healthz`, ({ request }) => {
        expect(request.headers.has('authorization')).toBe(false);
        expect(request.headers.has('cookie')).toBe(false);
        requested.push(new URL(request.url).pathname);
        return HttpResponse.json({ status: 'healthy' });
      }),
      http.get(`${API}/api/v1/health/status`, ({ request }) => {
        expect(request.headers.has('authorization')).toBe(false);
        requested.push(new URL(request.url).pathname);
        return HttpResponse.json(STATUS);
      }),
    );
    const lines = capture();
    await readHealth(`${API}/`, outputOptions(true));
    expect(JSON.parse(lines.join(''))).toEqual({
      apiUrl: API,
      liveness: 'healthy',
      ...STATUS,
      dependenciesChecked: false,
    });
    expect(requested.sort()).toEqual(['/api/v1/health/status', '/healthz']);
  });

  it('surfaces an HTTP refusal and prints no success result', async () => {
    healthy();
    server.use(
      http.get(`${API}/healthz`, () =>
        HttpResponse.json(
          {
            title: 'Unavailable',
            status: 503,
            detail: 'Core is restarting.',
            code: 'test.unavailable',
          },
          { status: 503, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    );
    const lines = capture();
    await expect(readHealth(API, outputOptions(true))).rejects.toMatchObject({
      status: 503,
      code: 'test.unavailable',
    });
    expect(lines).toEqual([]);
  });

  it.each([
    { ...STATUS, utcNow: 'not-a-server-clock' },
    { ...STATUS, service: 'another-app' },
  ])('refuses a non-Core response rather than reporting a false success: %j', async (status) => {
    healthy();
    server.use(http.get(`${API}/api/v1/health/status`, () => HttpResponse.json(status)));
    const lines = capture();
    await expect(readHealth(API, outputOptions(true))).rejects.toThrow();
    expect(lines).toEqual([]);
  });

  it.each([
    'file:///tmp/core',
    'http://user:secret@nix.test',
    `${API}/api`,
    `${API}?token=secret`,
    `${API}#fragment`,
  ])('refuses invalid or credential-bearing origins before I/O: %s', async (origin) => {
    await expect(readHealth(origin, outputOptions(true))).rejects.toThrow(/HTTP\(S\) origin/);
  });

  it('cancels a probe through the API client', async () => {
    healthy();
    const abort = new AbortController();
    abort.abort();
    await expect(readHealth(API, outputOptions(true), abort.signal)).rejects.toMatchObject({
      kind: 'canceled',
    });
  });
});
