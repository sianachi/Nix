import { describe, expect, it, vi } from 'vitest';
import { createPatTokenProvider, endpointsFor, openSession, whoami } from './session.ts';
import type { Profile } from './config.ts';

const profile: Profile = { apiUrl: 'http://localhost:5014', token: 'nixpat_abc' };

function exchangeResponse(accessToken: string, expiresInSeconds = 600): Response {
  return new Response(JSON.stringify({ accessToken, tokenType: 'Bearer', expiresInSeconds }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('the PAT token provider', () => {
  it('exchanges the personal access token for a session JWT', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(exchangeResponse('jwt-1')));
    const tokens = createPatTokenProvider({ profile, fetchImpl });

    expect(await tokens.getAccessToken()).toBe('jwt-1');
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:5014/public/v1/auth/token',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('serves the cached JWT until it nears expiry, then re-exchanges', async () => {
    let clock = 0;
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(exchangeResponse('jwt-1', 600))
      .mockResolvedValueOnce(exchangeResponse('jwt-2', 600));
    const tokens = createPatTokenProvider({ profile, fetchImpl, now: () => clock });

    expect(await tokens.getAccessToken()).toBe('jwt-1');
    clock = 100_000; // still comfortably inside the 600s lifetime
    expect(await tokens.getAccessToken()).toBe('jwt-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    clock = 590_000; // inside the 30s skew of the 600s expiry
    expect(await tokens.getAccessToken()).toBe('jwt-2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('collapses a burst of concurrent stale reads into one exchange', async () => {
    const fetchImpl = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return exchangeResponse('jwt-1');
    });
    const tokens = createPatTokenProvider({ profile, fetchImpl });

    const results = await Promise.all([
      tokens.getAccessToken(),
      tokens.getAccessToken(),
      tokens.getAccessToken(),
    ]);

    expect(results).toEqual(['jwt-1', 'jwt-1', 'jwt-1']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('surfaces Core its own refusal when the token cannot mint a session', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ code: 'auth.token_revoked', detail: 'That token was revoked.' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const tokens = createPatTokenProvider({ profile, fetchImpl });

    await expect(tokens.getAccessToken()).rejects.toThrow('That token was revoked.');
  });
});

describe('endpoint resolution', () => {
  it('derives the collab and media origins from the API URL when a profile omits them', () => {
    expect(endpointsFor(profile)).toEqual({
      apiUrl: 'http://localhost:5014',
      collabUrl: 'http://localhost:8100',
      mediaUrl: 'http://localhost:8200',
    });
  });

  it('honours explicit service URLs', () => {
    expect(endpointsFor({ ...profile, collabUrl: 'http://collab', mediaUrl: 'http://media' })).toEqual({
      apiUrl: 'http://localhost:5014',
      collabUrl: 'http://collab',
      mediaUrl: 'http://media',
    });
  });
});

describe('whoami', () => {
  it('reads the acting principal from /api/v1/me with the exchanged bearer', async () => {
    const fetchImpl = vi.fn((url: string) => {
      if (url.endsWith('/public/v1/auth/token')) {
        return Promise.resolve(exchangeResponse('jwt-1'));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 'p1',
            tenantId: 't1',
            displayName: 'Ada',
            email: 'ada@example.test',
            isTenantAdministrator: true,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    });
    const session = openSession({ profile, fetchImpl });

    const principal = await whoami(session, fetchImpl);

    expect(principal.displayName).toBe('Ada');
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:5014/api/v1/me',
      expect.objectContaining({ headers: { authorization: 'Bearer jwt-1' } }),
    );
  });
});
