import { createContext, use, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';

import { useSessionStore, type SessionProfile } from './session-store';

/**
 * Browser authentication is mediated by Core. Zitadel tokens never enter JavaScript: Core keeps
 * the provider exchange server-side, gives the browser an opaque HttpOnly session cookie, and
 * returns only a short-lived Core JWT for the existing API and collaboration bearer boundaries.
 */

export interface AuthContextValue {
  /** Starts the server-owned authorization-code redirect. */
  readonly signIn: () => Promise<void>;
  /** Revokes the local browser session and clears its cookie. */
  readonly signOut: () => Promise<void>;
  /** Returns a current short-lived Core access token without exposing the session cookie. */
  readonly getAccessToken: () => Promise<string | null>;
  /** Whether Core has the interactive provider and its signing key configured. */
  readonly isConfigured: boolean;
}

const browserProfileSchema = z.object({
  subject: z.string().min(1),
  name: z.string().min(1),
});

const browserSessionSchema = z.object({
  authenticated: z.boolean(),
  configured: z.boolean(),
  profile: browserProfileSchema.nullable(),
  accessToken: z.string().min(1).nullable(),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
});

const browserTokenSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: z.iso.datetime({ offset: true }),
});

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = use(AuthContext);
  if (value === null) {
    throw new Error('useAuth was called outside AuthProvider.');
  }

  return value;
}

export interface AuthProviderProps {
  readonly children: ReactNode;
}

interface AccessTokenState {
  readonly value: string;
  readonly expiresAt: number;
}

function toProfile(profile: z.infer<typeof browserProfileSchema>): SessionProfile {
  return { subject: profile.subject, name: profile.name, email: null };
}

async function readJson(response: Response): Promise<unknown> {
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
  if (mediaType !== 'application/json') {
    throw new Error('Core returned an unexpected browser-session response.');
  }

  return response.json();
}

export function AuthProvider({ children }: AuthProviderProps): ReactNode {
  // True until Core answers so the login screen never flashes a false configuration warning while
  // the session gate is still restoring. The response is authoritative before the gate settles.
  const [configured, setConfigured] = useState(true);
  const accessTokenRef = useRef<AccessTokenState | null>(null);
  const refreshRef = useRef<Promise<string | null> | null>(null);

  const signInStarted = useSessionStore((state) => state.signInStarted);
  const sessionRestoreCancelled = useSessionStore((state) => state.sessionRestoreCancelled);
  const signInSucceeded = useSessionStore((state) => state.signInSucceeded);
  const signInFailed = useSessionStore((state) => state.signInFailed);
  const signedOut = useSessionStore((state) => state.signedOut);

  useEffect(() => {
    if (useSessionStore.getState().status !== 'unknown') {
      return;
    }

    const controller = new AbortController();
    let settled = false;
    signInStarted();

    void fetch('/auth/session', {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('Core could not restore the browser session.');
        }

        return browserSessionSchema.parse(await readJson(response));
      })
      .then((session) => {
        if (controller.signal.aborted) {
          return;
        }

        settled = true;
        setConfigured(session.configured);
        if (
          session.authenticated &&
          session.profile !== null &&
          session.accessToken !== null &&
          session.expiresAt !== null
        ) {
          accessTokenRef.current = {
            value: session.accessToken,
            expiresAt: Date.parse(session.expiresAt),
          };
          signInSucceeded(toProfile(session.profile));
          return;
        }

        accessTokenRef.current = null;
        signedOut();
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }

        settled = true;
        accessTokenRef.current = null;
        signInFailed(error instanceof Error ? error.message : 'Session could not be restored.');
      });

    return () => {
      controller.abort();
      if (!settled) {
        sessionRestoreCancelled();
      }
    };
  }, [sessionRestoreCancelled, signInFailed, signInStarted, signInSucceeded, signedOut]);

  // Load-bearing identity: ApiClientProvider creates one client and retains these functions as its
  // token contract. They read mutable refs so renewal never requires recreating that client.
  const value = useMemo<AuthContextValue>(
    () => ({
      isConfigured: configured,

      signIn: () => {
        if (!configured) {
          signInFailed('Interactive sign-in is not configured on this Nix server.');
          return Promise.resolve();
        }

        signInStarted();
        const returnTo = `${globalThis.location.pathname}${globalThis.location.search}${globalThis.location.hash}`;
        globalThis.location.assign(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
        return Promise.resolve();
      },

      signOut: async () => {
        try {
          await fetch('/auth/logout', {
            method: 'POST',
            credentials: 'include',
            cache: 'no-store',
            headers: { Accept: 'application/json' },
          });
        } finally {
          accessTokenRef.current = null;
          refreshRef.current = null;
          signedOut();
        }
      },

      getAccessToken: async () => {
        const current = accessTokenRef.current;
        if (current !== null && current.expiresAt - Date.now() > 30_000) {
          return current.value;
        }

        if (refreshRef.current !== null) {
          return refreshRef.current;
        }

        const refresh = fetch('/auth/token', {
          method: 'POST',
          credentials: 'include',
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        })
          .then(async (response) => {
            if (response.status === 401) {
              accessTokenRef.current = null;
              signedOut();
              return null;
            }

            if (!response.ok) {
              return null;
            }

            const token = browserTokenSchema.parse(await readJson(response));
            accessTokenRef.current = {
              value: token.accessToken,
              expiresAt: Date.parse(token.expiresAt),
            };
            return token.accessToken;
          })
          .catch(() => null)
          .finally(() => {
            refreshRef.current = null;
          });
        refreshRef.current = refresh;
        return refresh;
      },
    }),
    [configured, signInFailed, signInStarted, signedOut],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}
