import { create } from 'zustand';

/**
 * Who is signed in, and where the sign-in process has got to.
 *
 * A Zustand slice rather than context, so a component subscribes to the one field it renders and a
 * token refresh does not re-render the whole application. Actions are named as events - what
 * happened - rather than as setters, which is what keeps the reducer readable when a fourth state
 * arrives.
 *
 * **The access token is deliberately not in this store.** Provider tokens never reach the browser;
 * a short-lived Core token lives only in AuthProvider's in-memory ref. Putting it here would put it
 * in devtools and state snapshots, neither of which needs it.
 */

export type SessionStatus =
  /** Nothing has been attempted yet; Core may still restore its HttpOnly session. */
  | 'unknown'
  /** Session restoration or the login redirect is in flight. */
  | 'authenticating'
  /** Signed in. */
  | 'authenticated'
  /** Signed out, or never signed in. */
  | 'anonymous'
  /** Sign-in was attempted and failed. `error` says why. */
  | 'failed';

export interface SessionProfile {
  /** The issuer's stable subject claim. Not an email - people change those. */
  readonly subject: string;
  readonly name: string;
  readonly email: string | null;
}

export interface SessionState {
  readonly status: SessionStatus;
  readonly profile: SessionProfile | null;
  readonly error: string | null;

  /** A sign-in or session restore has started. */
  readonly signInStarted: () => void;
  /** An in-flight startup restore was abandoned because its provider unmounted. */
  readonly sessionRestoreCancelled: () => void;
  /** The identity provider returned a user. */
  readonly signInSucceeded: (profile: SessionProfile) => void;
  /** Sign-in failed, or a renew failed and the session is gone. */
  readonly signInFailed: (message: string) => void;
  /** The session ended, deliberately or otherwise. */
  readonly signedOut: () => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  status: 'unknown',
  profile: null,
  error: null,

  signInStarted: () => {
    set({ status: 'authenticating', error: null });
  },

  sessionRestoreCancelled: () => {
    set((state) =>
      state.status === 'authenticating' ? { status: 'unknown', profile: null, error: null } : state,
    );
  },

  signInSucceeded: (profile) => {
    set({ status: 'authenticated', profile, error: null });
  },

  signInFailed: (message) => {
    // The profile is cleared as well as the status set: a half-signed-in state where a stale name
    // is still rendered next to a failure is exactly the kind of dishonest view to avoid.
    set({ status: 'failed', profile: null, error: message });
  },

  signedOut: () => {
    set({ status: 'anonymous', profile: null, error: null });
  },
}));

/** Selector: whether the application should render its authenticated shell. */
export const selectIsAuthenticated = (state: SessionState): boolean =>
  state.status === 'authenticated';

/** Selector: whether a sign-in is in flight, for disabling the button that started it. */
export const selectIsBusy = (state: SessionState): boolean =>
  state.status === 'authenticating' || state.status === 'unknown';
