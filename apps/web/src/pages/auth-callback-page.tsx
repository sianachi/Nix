import { Text } from '@nix/ui';
import { UserManager } from 'oidc-client-ts';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';

import {
  buildUserManagerSettings,
  isOidcConfigured,
  readOidcEnvironment,
} from '../auth/oidc-config';
import { useSessionStore } from '../auth/session-store';
import { rememberSession } from '../auth/session-hint';

/**
 * Where the identity provider sends the browser back to, carrying an authorization code.
 *
 * The code is exchanged for tokens here and then the URL is replaced, so the code never stays in
 * history: it is single-use, but leaving it in the address bar means it also ends up in any
 * screenshot, bookmark or referrer that follows.
 *
 * This screen is deliberately plain. It exists for a few hundred milliseconds and the honest thing
 * to show is that something is happening, not a skeleton of a page nobody will see.
 */
export function AuthCallbackPage(): ReactNode {
  const navigate = useNavigate();
  const signInSucceeded = useSessionStore((state) => state.signInSucceeded);
  const signInFailed = useSessionStore((state) => state.signInFailed);
  const [failure, setFailure] = useState<string | null>(null);

  const environment = useMemo(
    () => readOidcEnvironment(import.meta.env, globalThis.location.origin),
    [],
  );

  useEffect(() => {
    if (!isOidcConfigured(environment)) {
      // queueMicrotask, not a bare call: setting state synchronously inside an effect makes React
      // re-render before the effect finishes, and the linter is right that it cascades.
      queueMicrotask(() => {
        const message = 'No identity provider is configured for this build.';
        setFailure(message);
        signInFailed(message);
      });
      return;
    }

    const manager = new UserManager(buildUserManagerSettings(environment));

    void manager
      .signinRedirectCallback()
      .then((user) => {
        // `profile` is loosely typed by the library: every claim beyond `sub` is optional and
        // typed as unknown-ish, so each is narrowed here rather than assigned through.
        const claims: Record<string, unknown> = user.profile;
        const readString = (key: string): string | null =>
          typeof claims[key] === 'string' ? claims[key] : null;

        rememberSession();
        signInSucceeded({
          subject: user.profile.sub,
          name: readString('name') ?? readString('preferred_username') ?? user.profile.sub,
          email: readString('email'),
        });

        // replace, not push: the code must not be reachable with the back button.
        void navigate('/', { replace: true });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Sign-in could not be completed.';
        setFailure(message);
        signInFailed(message);
      });
  }, [environment, navigate, signInSucceeded, signInFailed]);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6">
      {failure === null ? (
        <Text variant="note" tone="muted">
          Completing sign-in…
        </Text>
      ) : (
        <div role="alert" className="max-w-md text-center">
          {/* text-primitive-exempt: display caps. The heading family at the h3 step with no
              heading weight and set in capitals - the sign-in screens' one display treatment,
              shared with the login wordmark and the item title. `<Text variant="h3">` would
              render this at weight 600 with tight tracking and no capitals, which is a different
              thing on the page; see type-adoption-specimen.tsx for why the primitive does not
              grow an uppercase display variant for three call sites. */}
          <p className="mb-2 font-heading text-xl uppercase">Sign-in failed</p>
          <Text variant="note" tone="muted">
            {failure}
          </Text>
        </div>
      )}
    </main>
  );
}

/**
 * The target of the hidden renew iframe.
 *
 * It renders nothing on purpose: the frame is invisible, and the only thing that has to happen is
 * for the library to post the result to the parent window.
 */
export function SilentRenewPage(): ReactNode {
  const environment = useMemo(
    () => readOidcEnvironment(import.meta.env, globalThis.location.origin),
    [],
  );

  useEffect(() => {
    if (!isOidcConfigured(environment)) {
      return;
    }

    const manager = new UserManager(buildUserManagerSettings(environment));
    void manager.signinSilentCallback().catch(() => {
      // Swallowed deliberately: the parent window's silent-renew-error event is what reports this,
      // and it has the context to decide whether it matters. There is nobody to tell in here.
    });
  }, [environment]);

  return null;
}
