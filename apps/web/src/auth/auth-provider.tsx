import { UserManager, type User } from 'oidc-client-ts';
import { createContext, use, useEffect, useMemo, useRef, type ReactNode } from 'react';

import { useSessionStore, type SessionProfile } from './session-store';
import { buildUserManagerSettings, isOidcConfigured, readOidcEnvironment } from './oidc-config';

/**
 * Owns the OIDC user manager and keeps the session store in step with it.
 *
 * The manager is the only thing that ever holds an access token. Components read who is signed in
 * from the Zustand slice; anything that needs to *call* the API asks this context for a token at
 * the moment of the call, so a token is never stored anywhere a component can accidentally render
 * it.
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
      signInSucceeded(toProfile(user));
    };
    const onUserUnloaded = (): void => {
      signedOut();
    };
    const onSilentRenewError = (error: Error): void => {
      signInFailed(`Session could not be renewed: ${error.message}`);
    };

    manager.events.addUserLoaded(onUserLoaded);
    manager.events.addUserUnloaded(onUserUnloaded);
    manager.events.addSilentRenewError(onSilentRenewError);

    // On a fresh page load the token store is empty by design, so try a silent renew before
    // concluding that nobody is signed in. A failure here is the ordinary "not signed in" case and
    // must not be reported as an error.
    //
    // Skipped when a session already exists, for the same reason as above.
    if (useSessionStore.getState().status !== 'unknown') {
      return () => {
        manager.events.removeUserLoaded(onUserLoaded);
        manager.events.removeUserUnloaded(onUserUnloaded);
        manager.events.removeSilentRenewError(onSilentRenewError);
      };
    }

    signInStarted();
    void manager
      .signinSilent()
      .then((user) => {
        if (user === null) {
          signedOut();
          return;
        }

        signInSucceeded(toProfile(user));
      })
      .catch(() => {
        signedOut();
      });

    return () => {
      manager.events.removeUserLoaded(onUserLoaded);
      manager.events.removeUserUnloaded(onUserUnloaded);
      manager.events.removeSilentRenewError(onSilentRenewError);
    };
  }, [signInStarted, signInSucceeded, signInFailed, signedOut]);

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
        return user?.access_token ?? null;
      },
    }),
    [configured, signInStarted, signInFailed, signedOut],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}
