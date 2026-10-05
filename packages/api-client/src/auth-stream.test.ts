import { describe, expect, it, vi } from 'vitest';
import { createInMemoryTokenStore, createRefreshCoordinator, sendAuthenticated } from './auth.js';

const STALE = 'stale-token';
const FRESH = 'fresh-token';

const respond = (status: number): Response => new Response(null, { status });

describe('sendAuthenticated', () => {
  it('attaches the bearer token to the first attempt', async () => {
    const tokens = createInMemoryTokenStore({
      initialAccessToken: STALE,
      refresh: () => Promise.resolve(FRESH),
    });
    const send = vi.fn(() => Promise.resolve(respond(200)));

    await sendAuthenticated(send, { tokens });

    expect(send).toHaveBeenCalledExactlyOnceWith({ Authorization: `Bearer ${STALE}` });
  });

  it('sends no Authorization header at all for an anonymous session', async () => {
    // An empty "Bearer null" header would be read by the server as a malformed credential.
    const tokens = createInMemoryTokenStore({ refresh: () => Promise.resolve(null) });
    const send = vi.fn(() => Promise.resolve(respond(200)));

    await sendAuthenticated(send, { tokens });

    expect(send).toHaveBeenCalledExactlyOnceWith({});
  });

  it('refreshes once on 401 and retries once with the new token', async () => {
    const refresh = vi.fn(() => Promise.resolve(FRESH));
    const tokens = createInMemoryTokenStore({ initialAccessToken: STALE, refresh });
    const send = vi
      .fn<(headers: Readonly<Record<string, string>>) => Promise<Response>>()
      .mockResolvedValueOnce(respond(401))
      .mockResolvedValueOnce(respond(200));

    const response = await sendAuthenticated(send, { tokens });

    expect(response.status).toBe(200);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({ Authorization: `Bearer ${FRESH}` });
  });

  it('never retries twice: a 401 that survives the retry is returned', async () => {
    // A third attempt would loop forever against a server that simply rejects the account.
    const refresh = vi.fn(() => Promise.resolve(FRESH));
    const tokens = createInMemoryTokenStore({ initialAccessToken: STALE, refresh });
    const send = vi.fn(() => Promise.resolve(respond(401)));

    const response = await sendAuthenticated(send, { tokens });

    expect(response.status).toBe(401);
    expect(send).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('returns the original 401 without a retry when the session cannot be renewed', async () => {
    const tokens = createInMemoryTokenStore({
      initialAccessToken: STALE,
      refresh: () => Promise.resolve(null),
    });
    const send = vi.fn(() => Promise.resolve(respond(401)));

    const response = await sendAuthenticated(send, { tokens });

    expect(response.status).toBe(401);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('retries with an already-replaced token without refreshing again', async () => {
    const refresh = vi.fn(() => Promise.resolve('never'));
    const tokens = createInMemoryTokenStore({ initialAccessToken: STALE, refresh });
    const send = vi
      .fn<(headers: Readonly<Record<string, string>>) => Promise<Response>>()
      .mockImplementationOnce(() => {
        // Another request finished its refresh while this one was in flight.
        tokens.setAccessToken(FRESH);
        return Promise.resolve(respond(401));
      })
      .mockResolvedValueOnce(respond(200));

    await sendAuthenticated(send, { tokens });

    expect(refresh).not.toHaveBeenCalled();
    expect(send).toHaveBeenLastCalledWith({ Authorization: `Bearer ${FRESH}` });
  });

  it('collapses concurrent 401s into one refresh', async () => {
    const refresh = vi.fn(() => Promise.resolve(FRESH));
    const tokens = createInMemoryTokenStore({ initialAccessToken: STALE, refresh });
    // The client shares one coordinator between its calls; the test does the same.
    const coordinator = createRefreshCoordinator(() => tokens.refreshAccessToken());
    const make = () =>
      vi.fn((headers: Readonly<Record<string, string>>) =>
        Promise.resolve(respond(headers.Authorization === `Bearer ${FRESH}` ? 200 : 401)),
      );

    const results = await Promise.all([
      sendAuthenticated(make(), { tokens, coordinator }),
      sendAuthenticated(make(), { tokens, coordinator }),
      sendAuthenticated(make(), { tokens, coordinator }),
    ]);

    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
