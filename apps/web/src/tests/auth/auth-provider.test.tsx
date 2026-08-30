import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider, useAuth } from '../../auth/auth-provider';
import { rememberSession } from '../../auth/session-hint';
import { useSessionStore } from '../../auth/session-store';

const oidc = vi.hoisted(() => ({
  addSilentRenewError: vi.fn(),
  addUserLoaded: vi.fn(),
  addUserUnloaded: vi.fn(),
  getUser: vi.fn(),
  removeSilentRenewError: vi.fn(),
  removeUserLoaded: vi.fn(),
  removeUserUnloaded: vi.fn(),
  signinRedirect: vi.fn(),
  signinSilent: vi.fn(),
  signoutRedirect: vi.fn(),
}));

vi.mock('oidc-client-ts', () => ({
  UserManager: vi.fn(() => ({
    events: {
      addSilentRenewError: oidc.addSilentRenewError,
      addUserLoaded: oidc.addUserLoaded,
      addUserUnloaded: oidc.addUserUnloaded,
      removeSilentRenewError: oidc.removeSilentRenewError,
      removeUserLoaded: oidc.removeUserLoaded,
      removeUserUnloaded: oidc.removeUserUnloaded,
    },
    getUser: oidc.getUser,
    signinRedirect: oidc.signinRedirect,
    signinSilent: oidc.signinSilent,
    signoutRedirect: oidc.signoutRedirect,
  })),
}));

const STORED_USER = {
  access_token: 'tab-scoped-token',
  profile: {
    sub: 'person-1',
    name: 'Stored Person',
    email: 'stored@example.test',
  },
};

const EXPIRED_USER = {
  ...STORED_USER,
  expired: true,
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve: (value) => {
      resolvePromise?.(value);
    },
  };
}

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

function SessionHarness() {
  const status = useSessionStore((state) => state.status);
  const auth = useAuth();
  const [accessToken, setAccessToken] = useState<string | null | undefined>(undefined);

  return (
    <div>
      <output>{status}</output>
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
  vi.clearAllMocks();
  vi.stubEnv('VITE_OIDC_ISSUER', 'https://identity.example.test');
  vi.stubEnv('VITE_OIDC_CLIENT_ID', 'nix-web');
  vi.stubGlobal('localStorage', memoryStorage());
  useSessionStore.setState({ status: 'unknown', profile: null, error: null });
  oidc.getUser.mockResolvedValue(null);
  oidc.signinSilent.mockResolvedValue(null);
  oidc.signoutRedirect.mockResolvedValue(undefined);
});

describe('session restoration', () => {
  it('checks the stored user and finishes anonymously without a hint or silent request', async () => {
    renderProvider();

    expect(await screen.findByText('anonymous')).toBeInTheDocument();
    expect(oidc.getUser).toHaveBeenCalledOnce();
    expect(oidc.signinSilent).not.toHaveBeenCalled();
  });

  it('attempts silent restoration when a prior-session hint remains', async () => {
    rememberSession();
    oidc.signinSilent.mockResolvedValue(STORED_USER);

    renderProvider();

    expect(await screen.findByText('authenticated')).toBeInTheDocument();
    expect(oidc.getUser).toHaveBeenCalledOnce();
    expect(oidc.signinSilent).toHaveBeenCalledOnce();
  });

  it('restores a valid stored user without making a silent request', async () => {
    oidc.getUser.mockResolvedValue(STORED_USER);

    renderProvider();

    expect(await screen.findByText('authenticated')).toBeInTheDocument();
    expect(oidc.getUser).toHaveBeenCalledOnce();
    expect(oidc.signinSilent).not.toHaveBeenCalled();
    expect(useSessionStore.getState().profile?.name).toBe('Stored Person');
  });

  it('silently replaces an expired stored user even when no prior-session hint remains', async () => {
    oidc.getUser.mockResolvedValue(EXPIRED_USER);
    oidc.signinSilent.mockResolvedValue({ ...STORED_USER, expired: false });

    renderProvider();

    expect(await screen.findByText('authenticated')).toBeInTheDocument();
    expect(oidc.signinSilent).toHaveBeenCalledOnce();
  });

  it('finishes anonymously and refuses the expired token when its restore fails', async () => {
    const user = userEvent.setup();
    oidc.getUser.mockResolvedValue(EXPIRED_USER);
    oidc.signinSilent.mockRejectedValue(new Error('provider session ended'));

    renderProvider();

    expect(await screen.findByText('anonymous')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Read access token' }));
    expect(await screen.findByText('No token')).toBeInTheDocument();
  });

  it('completes restoration when StrictMode replays the startup effect', async () => {
    renderProvider(true);

    expect(await screen.findByText('anonymous')).toBeInTheDocument();
    expect(oidc.getUser).toHaveBeenCalledTimes(2);
    expect(useSessionStore.getState().status).toBe('anonymous');
  });

  it('ignores a stored user returned after the provider unmounts', async () => {
    const storedUser = deferred<typeof STORED_USER | null>();
    oidc.getUser.mockReturnValue(storedUser.promise);
    const view = renderProvider();
    expect(oidc.getUser).toHaveBeenCalledOnce();

    view.unmount();
    storedUser.resolve(STORED_USER);
    await Promise.resolve();

    expect(useSessionStore.getState().status).toBe('unknown');
    expect(oidc.signinSilent).not.toHaveBeenCalled();
  });

  it('ignores a silent result and resets restoration after the provider unmounts', async () => {
    const silentUser = deferred<typeof STORED_USER | null>();
    rememberSession();
    oidc.signinSilent.mockReturnValue(silentUser.promise);
    const view = renderProvider();
    await waitFor(() => {
      expect(oidc.signinSilent).toHaveBeenCalledOnce();
    });

    view.unmount();
    silentUser.resolve(STORED_USER);
    await Promise.resolve();

    expect(useSessionStore.getState().status).toBe('unknown');
    expect(useSessionStore.getState().profile).toBeNull();
  });

  it('clears the prior-session hint as soon as explicit sign-out starts', async () => {
    const user = userEvent.setup();
    oidc.getUser.mockResolvedValue(STORED_USER);
    oidc.signoutRedirect.mockImplementation(() => new Promise(() => undefined));
    renderProvider();
    await screen.findByText('authenticated');

    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => {
      expect(localStorage.length).toBe(0);
    });
    expect(oidc.signoutRedirect).toHaveBeenCalledOnce();
  });
});
