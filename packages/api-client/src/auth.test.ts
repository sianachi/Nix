import { HttpResponse, delay, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { createInMemoryTokenStore, withAuthentication, type TokenStore } from './auth.js';
import { createHttpTransport, type HttpTransport } from './http.js';
import { TEST_BASE_URL, server, testUrl } from './testing/server.js';

const STALE = 'stale-access-token';
const FRESH = 'fresh-access-token';

let refreshCalls = 0;
let tokens: TokenStore;
let transport: HttpTransport;

async function refreshViaEndpoint(): Promise<string | null> {
  const response = await fetch(testUrl('/auth/refresh'), { method: 'POST' });
  if (!response.ok) return null;
  const body = (await response.json()) as { accessToken: string };
  return body.accessToken;
}

function bearer(request: Request): string | null {
  return request.headers.get('authorization');
}

beforeEach(() => {
  refreshCalls = 0;
  tokens = createInMemoryTokenStore({
    initialAccessToken: STALE,
    refresh: refreshViaEndpoint,
  });
  transport = withAuthentication(createHttpTransport({ baseUrl: TEST_BASE_URL }), { tokens });
});

describe('token attachment', () => {
  it('attaches the current access token to every request', async () => {
    const seen: (string | null)[] = [];
    server.use(
      http.get(testUrl('/items/:id'), ({ request }) => {
        seen.push(bearer(request));
        return HttpResponse.json({ ok: true });
      }),
    );

    await transport.send({ method: 'GET', path: '/items/1' });
    await transport.send({ method: 'GET', path: '/items/2' });

    expect(seen).toEqual([`Bearer ${STALE}`, `Bearer ${STALE}`]);
  });

  it('sends no authorization header when the session is anonymous', async () => {
    const anonymous = createInMemoryTokenStore({ refresh: () => Promise.resolve(null) });
    const anonymousTransport = withAuthentication(createHttpTransport({ baseUrl: TEST_BASE_URL }), {
      tokens: anonymous,
    });
    let header: string | null | undefined;
    server.use(
      http.get(testUrl('/public'), ({ request }) => {
        header = bearer(request);
        return HttpResponse.json({ ok: true });
      }),
    );

    await anonymousTransport.send({ method: 'GET', path: '/public' });

    expect(header).toBeNull();
  });
});

describe('refresh coordination', () => {
  beforeEach(() => {
    server.use(
      http.post(testUrl('/auth/refresh'), async () => {
        refreshCalls += 1;
        await delay(10);
        return HttpResponse.json({ accessToken: FRESH });
      }),
      http.get(testUrl('/items/:id'), ({ request }) => {
        if (bearer(request) !== `Bearer ${FRESH}`) {
          return HttpResponse.json(
            { title: 'Expired', status: 401, code: 'auth.token_expired' },
            { status: 401, headers: { 'content-type': 'application/problem+json' } },
          );
        }
        return HttpResponse.json({ ok: true });
      }),
    );
  });

  it('collapses concurrent 401s into a single refresh and retries every waiter', async () => {
    const responses = await Promise.all(
      ['1', '2', '3', '4', '5', '6'].map((id) =>
        transport.send({ method: 'GET', path: `/items/${id}` }),
      ),
    );

    expect(refreshCalls).toBe(1);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 200]);
  });

  it('retries with the token another request already obtained instead of refreshing again', async () => {
    server.use(
      http.get(testUrl('/slow-item'), async ({ request }) => {
        if (bearer(request) !== `Bearer ${FRESH}`) {
          await delay(60);
          return new HttpResponse(null, { status: 401 });
        }
        return HttpResponse.json({ ok: true });
      }),
    );

    const [slow, fast] = await Promise.all([
      transport.send({ method: 'GET', path: '/slow-item' }),
      transport.send({ method: 'GET', path: '/items/1' }),
    ]);

    expect(refreshCalls).toBe(1);
    expect(slow.status).toBe(200);
    expect(fast.status).toBe(200);
  });

  it('refreshes again for a later wave once the first refresh has settled', async () => {
    await transport.send({ method: 'GET', path: '/items/1' });
    tokens.setAccessToken(STALE);

    await transport.send({ method: 'GET', path: '/items/2' });

    expect(refreshCalls).toBe(2);
  });

  it('retries a request at most once so an unfixable 401 cannot loop', async () => {
    server.use(
      http.post(testUrl('/auth/refresh'), () => {
        refreshCalls += 1;
        return HttpResponse.json({ accessToken: 'still-not-accepted' });
      }),
    );

    const response = await transport.send({ method: 'GET', path: '/items/1' });

    expect(response.status).toBe(401);
    expect(refreshCalls).toBe(1);
  });

  it('surfaces the original 401 when the session cannot be renewed at all', async () => {
    server.use(
      http.post(testUrl('/auth/refresh'), () => {
        refreshCalls += 1;
        return new HttpResponse(null, { status: 401 });
      }),
    );

    const response = await transport.send({ method: 'GET', path: '/items/1' });

    expect(response.status).toBe(401);
    expect(await tokens.getAccessToken()).toBeNull();
  });
});
