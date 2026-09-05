import * as drafts from '../../editor/draft-journal';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider, useAuth } from '../../auth/auth-provider';
import { useSessionStore } from '../../auth/session-store';

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

function authenticated(): Response {
  return json({
    authenticated: true,
    configured: true,
    profile: { subject: 'person-1', name: 'Stored Person' },
    accessToken: 'core-session-token',
    expiresAt: future,
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
    renderProvider();
    await screen.findByText('authenticated');
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByText('failed');
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/auth/logout',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(useSessionStore.getState().error).toContain('Local drafts could not be cleared');
    clear.mockRestore();
    vi.unstubAllGlobals();
  });

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
    await user.click(screen.getByRole('button', { name: 'Read access token' }));
    expect(await screen.findByText('No token')).toBeInTheDocument();
  });
});
