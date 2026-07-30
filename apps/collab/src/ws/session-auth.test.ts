import { describe, expect, it } from 'vitest';

import type { Authorizer, ItemAuthorization } from '../auth/authorize.ts';
import type { TokenValidator } from '../auth/token.ts';
import { createSessionAuthenticator } from './session-auth.ts';

/**
 * The cache that makes a session affordable, and the bound that keeps it honest: a cached
 * "yes" must never outlive the credential it answered for.
 */

const ITEM = 'c1000000-0000-4000-8000-000000000031';

const GRANTED: ItemAuthorization = {
  tenantId: 'c1000000-0000-4000-8000-000000000001',
  principalId: 'c1000000-0000-4000-8000-000000000021',
  workspaceId: 'c1000000-0000-4000-8000-000000000011',
  canWrite: true,
  bodyKind: 'note',
};

function counting(overrides?: {
  expiresAt?: number | null;
  authorize?: Authorizer['authorize'];
}): { tokens: TokenValidator; authorizer: Authorizer; calls: { validated: number; authorized: number } } {
  const calls = { validated: 0, authorized: 0 };
  return {
    calls,
    tokens: {
      validate: () => {
        calls.validated += 1;
        return Promise.resolve({ subject: 'someone', expiresAt: overrides?.expiresAt ?? null });
      },
    },
    authorizer: {
      authorize:
        overrides?.authorize ??
        (() => {
          calls.authorized += 1;
          return Promise.resolve(GRANTED);
        }),
    },
  };
}

describe('session authentication', () => {
  it('answers from the cache within its lifetime, so a session does not cost a round trip per ask', async () => {
    let at = 1_000;
    const { tokens, authorizer, calls } = counting();
    const sessions = createSessionAuthenticator({ tokens, authorizer, cacheTtlMs: 500, now: () => at });

    await sessions.authenticate('token', ITEM);
    at += 400;
    const second = await sessions.authenticate('token', ITEM);

    expect(second.ok).toBe(true);
    expect(calls.authorized).toBe(1);
  });

  it('asks again once the cache entry has aged out', async () => {
    let at = 1_000;
    const { tokens, authorizer, calls } = counting();
    const sessions = createSessionAuthenticator({ tokens, authorizer, cacheTtlMs: 500, now: () => at });

    await sessions.authenticate('token', ITEM);
    at += 501;
    await sessions.authenticate('token', ITEM);

    expect(calls.authorized).toBe(2);
  });

  it('never believes a cached answer past the token expiry, whatever the cache lifetime says', async () => {
    let at = 1_000;
    const { tokens, authorizer, calls } = counting({ expiresAt: 1_200 });
    const sessions = createSessionAuthenticator({
      tokens,
      authorizer,
      cacheTtlMs: 60_000,
      now: () => at,
    });

    await sessions.authenticate('token', ITEM);
    at = 1_201;
    await sessions.authenticate('token', ITEM);

    // The second ask went back to the source: an hour-long cache must not stretch a
    // two-hundred-millisecond credential.
    expect(calls.validated).toBe(2);
    expect(calls.authorized).toBe(2);
  });

  it('distinguishes a bad token from a refused item, because the client reactions differ', async () => {
    const refused = createSessionAuthenticator({
      tokens: { validate: () => Promise.resolve({ subject: 's', expiresAt: null }) },
      authorizer: { authorize: () => Promise.resolve(null) },
    });
    const unauthenticated = createSessionAuthenticator({
      tokens: { validate: () => Promise.resolve(null) },
      authorizer: { authorize: () => Promise.resolve(GRANTED) },
    });

    expect(await refused.authenticate('token', ITEM)).toEqual({ ok: false, reason: 'refused' });
    expect(await unauthenticated.authenticate('token', ITEM)).toEqual({
      ok: false,
      reason: 'unauthenticated',
    });
  });

  it('never asks Core when the token does not validate', async () => {
    let asked = 0;
    const sessions = createSessionAuthenticator({
      tokens: { validate: () => Promise.resolve(null) },
      authorizer: {
        authorize: () => {
          asked += 1;
          return Promise.resolve(null);
        },
      },
    });

    await sessions.authenticate('forged', ITEM);

    expect(asked).toBe(0);
  });

  it('does not cache refusals, so a permission granted mid-session is seen at the next ask', async () => {
    let allowed = false;
    const sessions = createSessionAuthenticator({
      tokens: { validate: () => Promise.resolve({ subject: 's', expiresAt: null }) },
      authorizer: { authorize: () => Promise.resolve(allowed ? GRANTED : null) },
    });

    const before = await sessions.authenticate('token', ITEM);
    allowed = true;
    const after = await sessions.authenticate('token', ITEM);

    expect(before.ok).toBe(false);
    expect(after.ok).toBe(true);
  });

  it('sweeps expired entries so the cache is a cache and not a leak', async () => {
    let at = 1_000;
    const { tokens, authorizer } = counting();
    const sessions = createSessionAuthenticator({ tokens, authorizer, cacheTtlMs: 500, now: () => at });

    await sessions.authenticate('token-one', ITEM);
    await sessions.authenticate('token-two', ITEM);
    expect(sessions.size).toBe(2);

    at += 501;
    sessions.sweep();

    expect(sessions.size).toBe(0);
  });
});
