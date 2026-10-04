import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { createInMemoryTokenStore } from './auth.js';
import { createNixClient } from './client.js';
import { TEST_BASE_URL, server, testUrl } from './testing/server.js';

const STALE = 'stale-token';
const FRESH = 'fresh-token';

function makeClient(refresh: () => Promise<string | null> = () => Promise.resolve(FRESH)) {
  return createNixClient({
    baseUrl: TEST_BASE_URL,
    tokens: createInMemoryTokenStore({ initialAccessToken: STALE, refresh }),
    defaultHeaders: { 'X-Test': 'yes' },
  });
}

describe('client.stream', () => {
  it('posts the JSON body with the bearer token and stream-friendly headers', async () => {
    let seen: {
      auth: string | null;
      type: string | null;
      accept: string | null;
      extra: string | null;
      body: unknown;
    } | null = null;
    server.use(
      http.post(testUrl('/ai/stream'), async ({ request }) => {
        seen = {
          auth: request.headers.get('authorization'),
          type: request.headers.get('content-type'),
          accept: request.headers.get('accept'),
          extra: request.headers.get('x-test'),
          body: await request.json(),
        };
        return new HttpResponse('data: hi\n\n', {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }),
    );

    const response = await makeClient().stream({ path: '/ai/stream', body: { a: 1 } });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('data: hi\n\n');
    expect(seen).toEqual({
      auth: `Bearer ${STALE}`,
      type: 'application/json',
      accept: 'text/event-stream, application/problem+json',
      extra: 'yes',
      body: { a: 1 },
    });
  });

  it('refreshes once on 401 and retries once with the new token', async () => {
    const auths: (string | null)[] = [];
    server.use(
      http.post(testUrl('/ai/stream'), ({ request }) => {
        auths.push(request.headers.get('authorization'));
        return request.headers.get('authorization') === `Bearer ${FRESH}`
          ? new HttpResponse('ok')
          : new HttpResponse(null, { status: 401 });
      }),
    );

    const response = await makeClient().stream({ path: '/ai/stream', body: {} });

    expect(response.status).toBe(200);
    expect(auths).toEqual([`Bearer ${STALE}`, `Bearer ${FRESH}`]);
  });

  it('does not retry a second time when the retry is also 401', async () => {
    let calls = 0;
    server.use(
      http.post(testUrl('/ai/stream'), () => {
        calls += 1;
        return new HttpResponse(null, { status: 401 });
      }),
    );

    const response = await makeClient().stream({ path: '/ai/stream', body: {} });

    expect(response.status).toBe(401);
    expect(calls).toBe(2);
  });

  it('returns a non-2xx status as-is for the caller to map', async () => {
    server.use(
      http.post(testUrl('/ai/stream'), () =>
        HttpResponse.json(
          { code: 'rate_limited' },
          { status: 429, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    );

    const response = await makeClient().stream({ path: '/ai/stream', body: {} });

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ code: 'rate_limited' });
  });

  it('aborts the request when the caller aborts the signal', async () => {
    server.use(http.post(testUrl('/ai/stream'), () => new Promise<Response>(() => undefined)));
    const controller = new AbortController();

    const pending = makeClient().stream({
      path: '/ai/stream',
      body: {},
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects a path that is not relative to the base URL', async () => {
    // A token must never follow a caller-supplied absolute URL to another origin.
    const client = makeClient();

    await expect(client.stream({ path: 'https://evil.example/steal', body: {} })).rejects.toThrow(
      TypeError,
    );
  });

  it('builds the URL from the configured base only, never from the path', async () => {
    // Observed on the wire: `//evil.example/x` starts with "/" and so passes the guard, but is
    // concatenated onto the base, so the request still goes to the configured origin.
    let host: string | null = null;
    server.use(
      http.post(`${TEST_BASE_URL}//evil.example/x`, ({ request }) => {
        host = new URL(request.url).host;
        return new HttpResponse('ok');
      }),
    );

    const response = await makeClient().stream({ path: '//evil.example/x', body: {} });

    expect(response.status).toBe(200);
    expect(host).toBe('nix.test');
  });
});
