import { Text } from '@nix/ui';
import { type ReactNode } from 'react';
import { Outlet } from 'react-router';

import { useAuth } from '../auth/auth-provider';
import { useSessionStore } from '../auth/session-store';
import { LoginPage } from '../pages/login-page';

/**
 * The session gate: everything below it renders only for a signed-in person.
 *
 * It renders the login screen in place rather than redirecting to `/login`, so the URL a visitor
 * arrived at survives the sign-in and they land where they were going. A redirect would need the
 * original path stashed somewhere and restored afterwards, which is a small state machine to get
 * wrong for no gain.
 *
 * **All four states are distinct and none of them lies.** `unknown` and `authenticating` show that
 * something is in flight rather than flashing the login screen at someone who is already signed in;
 * `failed` shows the login screen *with* the reason; `anonymous` shows it plainly.
 */
export function RequireSession(): ReactNode {
  const status = useSessionStore((state) => state.status);
  const error = useSessionStore((state) => state.error);
  const { signIn, isConfigured } = useAuth();

  if (status === 'authenticated') {
    return <Outlet />;
  }

  if (status === 'unknown' || status === 'authenticating') {
    // A silent renew is in flight. Showing the login screen here would flash it in front of
    // someone whose session is about to be restored, which reads as being signed out.
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-6">
        <Text variant="note" tone="muted">
          Restoring session…
        </Text>
      </main>
    );
  }

  const configurationHint = isConfigured
    ? null
    : 'No identity provider is configured. Run deploy/seed/zitadel-configure.sh, then set VITE_OIDC_ISSUER and VITE_OIDC_CLIENT_ID.';

  return (
    <LoginPage
      organisation="acme"
      onSignIn={() => {
        void signIn();
      }}
      error={error ?? configurationHint}
      host={globalThis.location.host}
    />
  );
}
