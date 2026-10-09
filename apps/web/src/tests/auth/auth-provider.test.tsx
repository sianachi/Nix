import * as bodies from '../../editor/body-cache';
import * as drafts from '../../editor/draft-journal';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { StrictMode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider, useAuth } from '../../auth/auth-provider';
import { frecencyScores, recordPick } from '../../lib/frecency';
import { readDismissals, rememberDismissal } from '../../lib/suggestion-dismissals';
import { useSessionStore } from '../../auth/session-store';
import * as registerServiceWorker from '../../pwa/register-service-worker';

const future = '2099-01-01T00:00:00+00:00';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function anonymous(configured = true): Response {
  return json({
    authenticated: false,
    configured,
    profile: null,
    accessToken: null,
    expiresAt: null,
  });
}

function authenticated(extra: Record<string, unknown> = {}): Response {
  return json({
    authenticated: true,
    configured: true,
    profile: { subject: 'person-1', name: 'Stored Person' },
    accessToken: 'core-session-token',
    expiresAt: future,
    ...extra,
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value) => resolvePromise?.(value) };
}

function SessionHarness() {
  const status = useSessionStore((state) => state.status);
  const auth = useAuth();
  const [accessToken, setAccessToken] = useState<string | null>();

  return (
    <div>
      <output>{status}</output>
      <output aria-label="Configured">{auth.isConfigured ? 'Configured' : 'Unconfigured'}</output>
      <output aria-label="Account page">{auth.accountUrl ?? 'No account page'}</output>
      <button type="button" onClick={() => void auth.signOut()}>
        Sign out
      </button>
      <button
        type="button"
        onClick={() => {
          void auth.getAccessToken().then(setAccessToken);
        }}
      >
        Read access token
      </button>
      <output aria-label="Access token">{accessToken === null ? 'No token' : accessToken}</output>
    </div>
  );
}

function renderProvider(strict = false): ReturnType<typeof render> {
  const provider = (
    <AuthProvider>
      <SessionHarness />
    </AuthProvider>
  );
  return render(strict ? <StrictMode>{provider}</StrictMode> : provider);
}

beforeEach(() => {
  useSessionStore.setState({ status: 'unknown', profile: null, error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Core-mediated browser sessions', () => {
  it('finishes anonymously from the server session endpoint without provider traffic', async () => {
    const fetch = vi.fn().mockResolvedValue(anonymous());
    vi.stubGlobal('fetch', fetch);

    renderProvider();

    expect(await screen.findByText('anonymous')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      '/auth/session',
      expect.objectContaining({ credentials: 'include', cache: 'no-store' }),
    );
  });

  it('restores a profile and retains only the short-lived Core token in memory', async () => {
    const user = userEvent.setup();
    const fetch = vi.fn().mockResolvedValue(authenticated());
    vi.stubGlobal('fetch', fetch);

    renderProvider();

    expect(await screen.findByText('authenticated')).toBeInTheDocument();
    expect(useSessionStore.getState().profile).toEqual({
      subject: 'person-1',
      name: 'Stored Person',
      email: null,
    });
    await user.click(screen.getByRole('button', { name: 'Read access token' }));
    expect(await screen.findByText('core-session-token')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('offers the provider account page that Core names', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          authenticated({ accountUrl: 'https://sso.example.test/ui/console/users/me' }),
        ),
    );

    renderProvider();

    await waitFor(() => {
      expect(screen.getByRole('status', { name: 'Account page' })).toHaveTextContent(
        'https://sso.example.test/ui/console/users/me',
      );
    });
  });

  it('drops an account page that is not a web address but still signs in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(authenticated({ accountUrl: 'javascript:alert(1)' })),
    );

    renderProvider();

    expect(await screen.findByText('authenticated')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Account page' })).toHaveTextContent(
      'No account page',
    );
  });

  it('reports an unconfigured server only after its authoritative response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(anonymous(false)));

    renderProvider();

    expect(await screen.findByText('anonymous')).toBeInTheDocument();
    expect(screen.getByLabelText('Configured')).toHaveTextContent('Unconfigured');
  });

  it('restarts restoration when StrictMode replays the startup effect', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(anonymous()));
    vi.stubGlobal('fetch', fetch);

    renderProvider(true);

    expect(await screen.findByText('anonymous')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('aborts a deferred restore and returns the store to unknown when unmounted', async () => {
    const response = deferred<Response>();
    const fetch = vi.fn().mockReturnValue(response.promise);
    vi.stubGlobal('fetch', fetch);
    const view = renderProvider();

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledOnce();
    });
    const signal = (fetch.mock.calls[0]?.[1] as RequestInit | undefined)?.signal;
    view.unmount();
    expect(signal?.aborted).toBe(true);
    response.resolve(authenticated());
    await Promise.resolve();
    expect(useSessionStore.getState().status).toBe('unknown');
  });

  it('single-flights renewal of an expired in-memory token', async () => {
    const user = userEvent.setup();
    const refresh = deferred<Response>();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          authenticated: true,
          configured: true,
          profile: { subject: 'person-1', name: 'Stored Person' },
          accessToken: 'expired-core-token',
          expiresAt: '2000-01-01T00:00:00+00:00',
        }),
      )
      .mockReturnValue(refresh.promise);
    vi.stubGlobal('fetch', fetch);
    renderProvider();
    await screen.findByText('authenticated');

    await user.click(screen.getByRole('button', { name: 'Read access token' }));
    await user.click(screen.getByRole('button', { name: 'Read access token' }));
    expect(fetch).toHaveBeenCalledTimes(2);
    refresh.resolve(json({ accessToken: 'renewed-core-token', expiresAt: future }));
    expect(await screen.findByText('renewed-core-token')).toBeInTheDocument();
  });

  it('still signs out of Core when local draft cleanup is unavailable and reports the cleanup failure', async () => {
    const user = userEvent.setup();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(authenticated())
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('indexedDB', {});
    const clear = vi.spyOn(drafts, 'clearDrafts').mockRejectedValue(new Error('Storage blocked'));
    const clearBodies = vi.spyOn(bodies, 'clearBodyCache').mockResolvedValue(undefined);
    renderProvider();
    await screen.findByText('authenticated');
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByText('failed');
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/auth/logout',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(useSessionStore.getState().error).toContain('could not be cleared');
    clear.mockRestore();
    clearBodies.mockRestore();
    vi.unstubAllGlobals();
  });

  it('reports an unreachable Core as offline rather than a failed sign-in, and retries when the network returns', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(authenticated());
    vi.stubGlobal('fetch', fetch);
    renderProvider();
    expect(await screen.findByText('unreachable')).toBeInTheDocument();

    window.dispatchEvent(new Event('online'));

    expect(await screen.findByText('authenticated')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('treats a proxy answering for a stopped Core as unreachable, not a failed sign-in', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Bad gateway', { status: 502 })));
    renderProvider();
    expect(await screen.findByText('unreachable')).toBeInTheDocument();
    expect(useSessionStore.getState().unreachable?.cause).toBe('server');
    vi.unstubAllGlobals();
  });

  it('keeps retrying on a timer while Core stays unreachable, without waiting for a network change', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(authenticated());
    vi.stubGlobal('fetch', fetch);
    renderProvider();
    expect(await screen.findByText('unreachable')).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(await screen.findByText('authenticated')).toBeInTheDocument();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reports a bug in reading the session as a failure, not as an outage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ authenticated: true, configured: true, profile: 7 })),
    );
    renderProvider();
    expect(await screen.findByText('failed')).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('still reports a malformed session response as a failed sign-in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html></html>', { status: 200 })),
    );
    renderProvider();
    expect(await screen.findByText('failed')).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('removes locally saved pages along with drafts when signing out', async () => {
    const user = userEvent.setup();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(authenticated())
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('indexedDB', new IDBFactory());
    const clearDrafts = vi.spyOn(drafts, 'clearDrafts').mockResolvedValue(undefined);
    const clearBodies = vi.spyOn(bodies, 'clearBodyCache').mockResolvedValue(undefined);
    renderProvider();
    await screen.findByText('authenticated');
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByText('anonymous');
    expect(clearDrafts).toHaveBeenCalledOnce();
    expect(clearBodies).toHaveBeenCalledOnce();
    clearDrafts.mockRestore();
    clearBodies.mockRestore();
    vi.unstubAllGlobals();
  });

  it.each(['local', 'another tab'])(
    'clears pre-upgrade recording chunks on %s sign-out',
    async (source) => {
      const factory = new IDBFactory();
      vi.stubGlobal('indexedDB', factory);
      vi.spyOn(bodies, 'openBodyCache').mockResolvedValue(undefined);
      vi.spyOn(bodies, 'clearBodyCache').mockResolvedValue(undefined);
      vi.spyOn(drafts, 'clearDrafts').mockResolvedValue(undefined);
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = factory.open('nix-recordings', 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('sessions', { keyPath: 'id' });
          request.result.createObjectStore('chunks', { keyPath: ['sessionId', 'index'] });
        };
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          reject(new Error('Recording fixture request failed.', { cause: request.error }));
        };
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction(['sessions', 'chunks'], 'readwrite');
          transaction.objectStore('sessions').put({ id: 'old-recording', principalId: 'person-1' });
          transaction
            .objectStore('chunks')
            .put({ sessionId: 'old-recording', index: 0, bytes: new ArrayBuffer(16) });
          transaction.oncomplete = () => {
            resolve();
          };
          transaction.onerror = () => {
            reject(
              new Error('Recording fixture transaction failed.', { cause: transaction.error }),
            );
          };
        });
        vi.stubGlobal(
          'fetch',
          vi
            .fn()
            .mockResolvedValueOnce(authenticated())
            .mockResolvedValueOnce(new Response(null, { status: 204 })),
        );
        renderProvider();
        await screen.findByText('authenticated');
        if (source === 'local') {
          await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));
        } else {
          window.dispatchEvent(new Event('nix:signed-out-elsewhere'));
        }
        await screen.findByText('anonymous');
        // Keep the old tab's handle open: deleting the database would remain blocked.
        await waitFor(async () => {
          for (const name of ['sessions', 'chunks']) {
            const count = await new Promise<number>((resolve, reject) => {
              const request = db.transaction(name).objectStore(name).count();
              request.onsuccess = () => {
                resolve(request.result);
              };
              request.onerror = () => {
                reject(new Error('Recording fixture request failed.', { cause: request.error }));
              };
            });
            expect(count).toBe(0);
          }
        });
      } finally {
        db.close();
        vi.unstubAllGlobals();
      }
    },
  );

  it('revokes the Core session and clears the in-memory token on sign-out', async () => {
    const user = userEvent.setup();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(authenticated())
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({}, 401));
    vi.stubGlobal('fetch', fetch);
    renderProvider();
    await screen.findByText('authenticated');

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('anonymous')).toBeInTheDocument();
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/auth/logout',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
    // A deliberate sign-out needs no excuse - it is not the answer to "what happened", it is
    // what the person just asked for. Checked before the next click, which itself triggers a
    // renewal attempt (and this fixture's mocked 401) that is not part of what this test is about.
    expect(useSessionStore.getState().error).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Read access token' }));
    expect(await screen.findByText('No token')).toBeInTheDocument();
  });

  it('unsubscribes this device from push, and reports it to Core, before the Core session ends', async () => {
    const user = userEvent.setup();
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const getSubscription = vi
      .fn()
      .mockResolvedValue({ endpoint: 'https://push.example/device-1', unsubscribe });
    vi.spyOn(registerServiceWorker, 'getServiceWorkerRegistration').mockReturnValue({
      pushManager: { getSubscription },
    } as unknown as ServiceWorkerRegistration);

    const fetch = vi
      .fn()
      .mockResolvedValueOnce(authenticated())
      .mockResolvedValueOnce(new Response(null, { status: 204 })) // the push-subscription DELETE
      .mockResolvedValueOnce(new Response(null, { status: 204 })) // /auth/logout
      .mockResolvedValueOnce(json({}, 401));
    vi.stubGlobal('fetch', fetch);
    renderProvider();
    await screen.findByText('authenticated');

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('anonymous')).toBeInTheDocument();

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/v1/me/push-subscriptions', {
      method: 'DELETE',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer core-session-token',
      },
      body: JSON.stringify({ endpoint: 'https://push.example/device-1' }),
    });
    // The unsubscribe runs before the bearer token is cleared, and before the cookie session
    // ends - the whole point is to still be able to authenticate the DELETE.
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      '/auth/logout',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('signs out normally when there is no push subscription to remove', async () => {
    const user = userEvent.setup();
    vi.spyOn(registerServiceWorker, 'getServiceWorkerRegistration').mockReturnValue(undefined);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(authenticated())
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({}, 401));
    vi.stubGlobal('fetch', fetch);
    renderProvider();
    await screen.findByText('authenticated');

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('anonymous')).toBeInTheDocument();
    // No registration means nothing to unsubscribe - straight to /auth/logout as the first call.
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/auth/logout',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('explains that the session expired when a renew finds it gone, unlike a deliberate sign-out', async () => {
    const user = userEvent.setup();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          authenticated: true,
          configured: true,
          profile: { subject: 'person-1', name: 'Stored Person' },
          accessToken: 'expired-core-token',
          expiresAt: '2000-01-01T00:00:00+00:00',
        }),
      )
      .mockResolvedValueOnce(json({}, 401));
    vi.stubGlobal('fetch', fetch);
    renderProvider();
    await screen.findByText('authenticated');

    await user.click(screen.getByRole('button', { name: 'Read access token' }));

    expect(await screen.findByText('anonymous')).toBeInTheDocument();
    expect(useSessionStore.getState().error).toBe(
      'Your session expired. Sign in again to continue.',
    );
  });

  it('forgets pick history and dismissed suggestions when another tab signs out', async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(authenticated()));
    renderProvider();
    await screen.findByText('authenticated');
    recordPick('select:w1:status', 'Done');
    rememberDismissal('mention:w1:item-1');

    window.dispatchEvent(new Event('nix:signed-out-elsewhere'));

    expect(await screen.findByText('anonymous')).toBeInTheDocument();
    expect(frecencyScores('select:w1:status').size).toBe(0);
    expect(readDismissals().size).toBe(0);
    vi.unstubAllGlobals();
  });

  it('forgets pick history and dismissed suggestions on sign-out', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('localStorage', memoryStorage());
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(authenticated())
        .mockResolvedValueOnce(new Response(null, { status: 204 })),
    );
    renderProvider();
    await screen.findByText('authenticated');
    recordPick('slash', 'heading');
    rememberDismissal('mention:w1:item-1');

    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    await screen.findByText('anonymous');
    expect(frecencyScores('slash').size).toBe(0);
    expect(readDismissals().size).toBe(0);
    vi.unstubAllGlobals();
  });
});

/** An in-memory `Storage`: the test environment's global is not a usable one. */
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => {
      values.clear();
    },
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}
