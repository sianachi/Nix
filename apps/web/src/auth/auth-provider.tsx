import { clearBodyCache, openBodyCache } from '../editor/body-cache';
import { clearFrecency } from '../lib/frecency';
import { clearSuggestionDismissals } from '../lib/suggestion-dismissals';
import { clearDrafts } from '../editor/draft-journal';
import { clearInterruptedImport } from '../import/import-interrupted-notice';
import { createContext, use, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';

import { getServiceWorkerRegistration } from '../pwa/register-service-worker';
import { useSessionStore, type SessionProfile } from './session-store';

/**
 * Unsubscribes this device from push and tells Core to forget the subscription, before the
 * session that registered it ends. A shared browser must not keep delivering the outgoing
 * account's reminders to whoever uses it next.
 *
 * Entirely best-effort: every failure is swallowed and nothing here ever blocks or fails
 * sign-out. This runs ahead of `/auth/logout` (and therefore ahead of `accessTokenRef` being
 * cleared) specifically so the DELETE still carries a valid bearer token - `AuthProvider` sits
 * outside `ApiClientProvider` in `app.tsx` and has no `NixClient` of its own to reach for.
 */
async function unsubscribePushBeforeSignOut(accessToken: string | null): Promise<void> {
  try {
    const registration = getServiceWorkerRegistration();
    if (!registration) return;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;
    const endpoint = subscription.endpoint;
    await subscription.unsubscribe().catch(() => undefined);
    await fetch('/api/v1/me/push-subscriptions', {
      method: 'DELETE',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken === null ? {} : { Authorization: `Bearer ${accessToken}` }),
      },
      body: JSON.stringify({ endpoint }),
    });
  } catch {
    // Best-effort: sign-out proceeds either way. A subscription left behind here is still
    // useless to deliver to, since the account it was registered for is about to be signed out.
  }
}

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
  /**
   * The identity provider's self-service page - password, passkeys, second factors - or null when
   * the deployment names none. Nix never handles credentials; it only points at where they live.
   */
  readonly accountUrl: string | null;
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
  // Rendered as a link, so only a web address is kept: a javascript: URL from a misconfigured
  // deployment is dropped rather than becoming a click, without costing the sign-in itself.
  accountUrl: z
    .url({ protocol: /^https?$/ })
    .nullish()
    .catch(null),
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

/** Core could not be reached: no response arrived, or a proxy answered for it. */
class CoreUnreachable extends Error {
  constructor(readonly reason: 'offline' | 'server') {
    super(reason === 'offline' ? 'This device is offline.' : 'The Nix server is not answering.');
  }
}

/** Whether a request that got no answer at all did so for want of a network on this device. */
function networkCause(): 'offline' | 'server' {
  return typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'server';
}

/** How long to wait before each automatic retry while Core is unreachable. */
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000] as const;

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
  const [accountUrl, setAccountUrl] = useState<string | null>(null);
  const accessTokenRef = useRef<AccessTokenState | null>(null);
  const refreshRef = useRef<Promise<string | null> | null>(null);

  const signInStarted = useSessionStore((state) => state.signInStarted);
  const sessionRestoreCancelled = useSessionStore((state) => state.sessionRestoreCancelled);
  const signInSucceeded = useSessionStore((state) => state.signInSucceeded);
  const signInFailed = useSessionStore((state) => state.signInFailed);
  const signedOut = useSessionStore((state) => state.signedOut);
  const sessionUnreachable = useSessionStore((state) => state.sessionUnreachable);
  const sessionRetryRequested = useSessionStore((state) => state.sessionRetryRequested);
  const restoreAttempt = useSessionStore((state) => state.restoreAttempt);

  useEffect(() => {
    // A remounted provider must not replace a definitive in-memory state with a second restore.
    // The application starts at `unknown`, while tests and an explicit sign-out may already have
    // established an authenticated, anonymous, or failed state before this effect runs.
    if (useSessionStore.getState().status !== 'unknown') {
      return;
    }

    const controller = new AbortController();
    const isAborted = (): boolean => controller.signal.aborted;
    let settled = false;
    signInStarted();

    void fetch('/auth/session', {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
      // Classified here, at the one call that can fail for want of a network, rather than by
      // error type below: a TypeError from a bug later in this chain is a failure to report, not
      // an outage to wait out.
      .catch((cause: unknown) => {
        throw controller.signal.aborted ? cause : new CoreUnreachable(networkCause());
      })
      .then(async (response) => {
        // A proxy answering for a Core that is down or restarting.
        if (response.status === 502 || response.status === 503 || response.status === 504) {
          throw new CoreUnreachable('server');
        }
        if (!response.ok) {
          throw new Error('Core could not restore the browser session.');
        }

        return browserSessionSchema.parse(await readJson(response));
      })
      .then(async (session) => {
        if (controller.signal.aborted) {
          return;
        }

        settled = true;
        setConfigured(session.configured);
        setAccountUrl(session.accountUrl ?? null);
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
          const profile = toProfile(session.profile);
          // Opened before the workspace can mount an editor: a different person than the store
          // last belonged to clears it first. A store that cannot be opened stays closed, which
          // costs only the instant first paint.
          await openBodyCache(profile.subject).catch(() => undefined);
          // Read through a call: the narrowing above cannot see an abort during the await.
          if (isAborted()) return;
          signInSucceeded(profile);
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
        if (error instanceof CoreUnreachable) {
          sessionUnreachable(error.reason);
          return;
        }
        signInFailed(error instanceof Error ? error.message : 'Session could not be restored.');
      });

    return () => {
      controller.abort();
      if (!settled) {
        sessionRestoreCancelled();
      }
    };
  }, [
    restoreAttempt,
    sessionRestoreCancelled,
    sessionUnreachable,
    signInFailed,
    signInStarted,
    signInSucceeded,
    signedOut,
  ]);

  // While Core is unreachable: try again the moment the device reports a network, and on a
  // lengthening timer regardless - a server that is down comes back without the device's network
  // ever changing, so waiting for `online` alone would wait forever.
  const status = useSessionStore((state) => state.status);
  useEffect(() => {
    if (status !== 'unreachable') return;
    const delay = RETRY_DELAYS_MS[Math.min(restoreAttempt, RETRY_DELAYS_MS.length - 1)];
    const timer = setTimeout(sessionRetryRequested, delay);
    window.addEventListener('online', sessionRetryRequested);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('online', sessionRetryRequested);
    };
  }, [restoreAttempt, sessionRetryRequested, status]);

  useEffect(() => {
    const clearSession = (): void => {
      accessTokenRef.current = null;
      refreshRef.current = null;
      signedOut();
      // Shared localStorage, already cleared by the signing-out tab; clearing again also drops
      // this tab's in-memory frecency cache.
      clearFrecency();
      clearSuggestionDismissals();
      // The signing-out tab already cleared the shared store; clearing here as well stops this
      // tab's editors from writing a copy back after it did.
      if (typeof indexedDB !== 'undefined') void clearBodyCache().catch(() => undefined);
    };
    window.addEventListener('nix:signed-out-elsewhere', clearSession);
    return () => {
      window.removeEventListener('nix:signed-out-elsewhere', clearSession);
    };
  }, [signedOut]);

  // Load-bearing identity: ApiClientProvider creates one client and retains these functions as its
  // token contract. They read mutable refs so renewal never requires recreating that client.
  const value = useMemo<AuthContextValue>(
    () => ({
      isConfigured: configured,
      accountUrl,

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
        clearInterruptedImport();
        clearFrecency();
        clearSuggestionDismissals();
        await unsubscribePushBeforeSignOut(accessTokenRef.current?.value ?? null);
        const draftsCleared =
          typeof indexedDB === 'undefined' ||
          (await Promise.all([clearDrafts(), clearBodyCache()]).then(
            () => true,
            () => false,
          ));
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
          if (!draftsCleared)
            signInFailed(
              'Signed out. Local drafts and saved pages could not be cleared. Clear this site’s storage before sharing this device.',
            );
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
              signedOut('Your session expired. Sign in again to continue.');
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
    [accountUrl, configured, signInFailed, signInStarted, signedOut],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}
