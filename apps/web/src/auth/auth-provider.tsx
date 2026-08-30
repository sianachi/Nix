import { UserManager, type User } from 'oidc-client-ts';
import { createContext, use, useEffect, useMemo, useRef, type ReactNode } from 'react';

import { useSessionStore, type SessionProfile } from './session-store';
import { buildUserManagerSettings, isOidcConfigured, readOidcEnvironment } from './oidc-config';
import { forgetSession, hasSessionHint, rememberSession } from './session-hint';

/**
 * Owns the OIDC user manager and keeps the session store in step with it.
 *
 * The manager's tab-scoped user store is the only place that ever holds an access token.
 * Components read who is signed in from the Zustand slice; anything that needs to *call* the API
 * asks this context for a token at the moment of the call, so a token is never copied somewhere a
 * component can accidentally render it.
 */

export interface AuthContextValue {
  /** Starts the redirect to the identity provider. */
  readonly signIn: () => Promise<void>;
  /** Ends the session, locally and at the provider. */
  readonly signOut: () => Promise<void>;
  /**
   * The current access token, or null when there is no session.
   *
   * Async because a renew may be in flight; callers await it per request rather than caching it,
   * which is what stops a stale token being sent after a silent renew has replaced it.
   */
  readonly getAccessToken: () => Promise<string | null>;
  /** Whether the deployment has an issuer and client id configured at all. */
  readonly isConfigured: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = use(AuthContext);
  if (value === null) {
    throw new Error('useAuth was called outside AuthProvider.');
  }

  return value;
}

function toProfile(user: User): SessionProfile {
  const claims = user.profile;
  return {
    subject: claims.sub,
    // `name` is optional in OIDC; falling back to the subject keeps the shell honest rather than
    // rendering an empty chip where a person's name should be.
    name: claims.name ?? claims.preferred_username ?? claims.sub,
    email: claims.email ?? null,
  };
}

export interface AuthProviderProps {
  readonly children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps): ReactNode {
  const environment = useMemo(
    () => readOidcEnvironment(import.meta.env, globalThis.location.origin),
    [],
  );

  const configured = isOidcConfigured(environment);

  const managerRef = useRef<UserManager | null>(null);
  managerRef.current ??= configured ? new UserManager(buildUserManagerSettings(environment)) : null;

  const signInStarted = useSessionStore((state) => state.signInStarted);
  const sessionRestoreCancelled = useSessionStore((state) => state.sessionRestoreCancelled);
  const signInSucceeded = useSessionStore((state) => state.signInSucceeded);
  const signInFailed = useSessionStore((state) => state.signInFailed);
  const signedOut = useSessionStore((state) => state.signedOut);

  useEffect(() => {
    const manager = managerRef.current;

    if (manager === null) {
      // No issuer configured. Say so once, as an anonymous session, rather than leaving the shell
      // spinning on "unknown" forever - a login screen that never becomes interactive is worse
      // than one that explains why.
      //
      // Only from `unknown`, though. This provider reports what it discovers; it does not
      // overwrite a session someone else established, which is what lets a test seed one and what
      // stops a late-mounting provider signing a person out.
      if (useSessionStore.getState().status === 'unknown') {
        signedOut();
      }

      return;
    }

    const onUserLoaded = (user: User): void => {
      if (user.expired === true) {
        forgetSession();
        signedOut();
        return;
      }

      rememberSession();
      signInSucceeded(toProfile(user));
    };
    const onUserUnloaded = (): void => {
      forgetSession();
      signedOut();
    };
    const onSilentRenewError = (error: Error): void => {
      forgetSession();
      signInFailed(`Session could not be renewed: ${error.message}`);
    };

    manager.events.addUserLoaded(onUserLoaded);
    manager.events.addUserUnloaded(onUserUnloaded);
    manager.events.addSilentRenewError(onSilentRenewError);

    // oidc-client-ts persists its user in sessionStorage, so consult that tab-scoped store before
    // doing any network work. Only ask the identity provider to restore a missing stored user when
    // this browser has completed sign-in before: an anonymous first visit cannot possibly be
    // restored, and waiting for the hidden iframe's production timeout made the login screen
    // appear broken for several seconds.
    //
    // Skipped when a session already exists, for the same reason as above.
    if (useSessionStore.getState().status !== 'unknown') {
      return () => {
        manager.events.removeUserLoaded(onUserLoaded);
        manager.events.removeUserUnloaded(onUserUnloaded);
        manager.events.removeSilentRenewError(onSilentRenewError);
      };
    }

    const lifecycle = { completed: false, disposed: false };
    const isDisposed = (): boolean => lifecycle.disposed;
    const complete = (): void => {
      lifecycle.completed = true;
    };
    void (async () => {
      let user: User | null;
      try {
        user = await manager.getUser();
      } catch {
        // A blocked or corrupt tab store is equivalent to no stored user. The non-secret hint
        // below still determines whether the provider may have a session worth restoring.
        user = null;
      }

      if (isDisposed()) {
        return;
      }

      if (user !== null && user.expired !== true) {
        complete();
        rememberSession();
        signInSucceeded(toProfile(user));
        return;
      }

      const storedUserExpired = user?.expired === true;
      if (!storedUserExpired && !hasSessionHint()) {
        complete();
        signedOut();
        return;
      }

      signInStarted();
      try {
        user = await manager.signinSilent();
        if (isDisposed()) {
          return;
        }

        if (user === null || user.expired === true) {
          complete();
          forgetSession();
          signedOut();
          return;
        }

        complete();
        rememberSession();
        signInSucceeded(toProfile(user));
      } catch {
        if (isDisposed()) {
          return;
        }

        complete();
        forgetSession();
        signedOut();
      }
    })();

    return () => {
      lifecycle.disposed = true;
      if (!lifecycle.completed) {
        sessionRestoreCancelled();
      }
      manager.events.removeUserLoaded(onUserLoaded);
      manager.events.removeUserUnloaded(onUserUnloaded);
      manager.events.removeSilentRenewError(onSilentRenewError);
    };
  }, [signInStarted, sessionRestoreCancelled, signInSucceeded, signInFailed, signedOut]);

  const value = useMemo<AuthContextValue>(
    () => ({
      isConfigured: configured,

      signIn: async () => {
        const manager = managerRef.current;
        if (manager === null) {
          signInFailed(
            'No identity provider is configured. Run deploy/seed/zitadel-configure.sh and set VITE_OIDC_ISSUER and VITE_OIDC_CLIENT_ID.',
          );
          return;
        }

        signInStarted();
        try {
          await manager.signinRedirect();
        } catch (error) {
          signInFailed(error instanceof Error ? error.message : 'Sign-in could not be started.');
        }
      },

      signOut: async () => {
        const manager = managerRef.current;
        forgetSession();
        if (manager === null) {
          signedOut();
          return;
        }

        try {
          await manager.signoutRedirect();
        } finally {
          signedOut();
        }
      },

      getAccessToken: async () => {
        const manager = managerRef.current;
        if (manager === null) {
          return null;
        }

        const user = await manager.getUser();
        return user === null || user.expired === true ? null : user.access_token;
      },
    }),
    [configured, signInStarted, signInFailed, signedOut],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}
