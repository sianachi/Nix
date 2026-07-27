import { Blueprint, Button, Icon, Text } from '@nix/ui';
import { ArrowRight, Lock } from 'lucide-react';
import { type ReactNode } from 'react';

import { selectIsBusy, useSessionStore } from '../auth/session-store';

/**
 * The sign-in screen, per Fig. Login of the design language.
 *
 * A 400/300 split card centred on the blueprint grid: the sign-in column on the left, recent
 * workspaces on the right. The proportions, the 34px grid, the faux desktop titlebar and the
 * hairline dividers are all from the design file rather than invented here.
 *
 * **There is no password field and there never will be.** Authentication is the tenant's identity
 * provider's job; Nix stores no credentials, and the organisation field exists only to pick which
 * issuer to redirect to. The copy says so, because a sign-in screen that looks like it might want a
 * password teaches people to type one somewhere.
 */

export interface RecentWorkspace {
  readonly id: string;
  readonly name: string;
  readonly initials: string;
  readonly openedLabel: string;
}

export interface LoginPageProps {
  /** The organisation slug, shown before the `.nix.app` suffix. */
  readonly organisation: string;
  /** Starts the redirect to the identity provider. */
  readonly onSignIn: () => void;
  /** Workspaces this browser has opened before. Empty on a first visit, and honestly so. */
  readonly recentWorkspaces?: readonly RecentWorkspace[];
  /** Whether the API answered its liveness probe. */
  readonly serverReachable?: boolean;
  /** The host the client is configured against. */
  readonly host?: string;
  /** The running build. */
  readonly version?: string;
  /** Why the last attempt failed, when one did. */
  readonly error?: string | null;
}

export function LoginPage({
  organisation,
  onSignIn,
  recentWorkspaces = [],
  serverReachable = true,
  host = 'localhost',
  version = '0.0.0',
  error = null,
}: LoginPageProps): ReactNode {
  const isBusy = useSessionStore(selectIsBusy);

  return (
    <main className="flex min-h-dvh flex-col bg-background">
      <FauxTitleBar />

      {/* The blueprint grid, at the same 5% accent the design file draws it at - mixed from the
          accent role rather than written out as its rgb triple, which was the one colour on this
          screen that could not follow the ground. */}
      <div className="relative flex flex-1 items-center justify-center bg-[linear-gradient(to_right,var(--grid-rule)_1px,transparent_1px),linear-gradient(to_bottom,var(--grid-rule)_1px,transparent_1px)] [--grid-rule:color-mix(in_srgb,var(--color-accent)_5%,transparent)] bg-[length:34px_34px] px-6 py-12">
        <div className="grid w-full max-w-[700px] grid-cols-1 border border-divider bg-background shadow-md md:grid-cols-[400px_300px]">
          <section className="flex flex-col border-divider p-11 md:border-r">
            <Blueprint className="mb-[22px] inline-flex size-[52px] items-center justify-center">
              <span className="font-heading text-2xl font-semibold tracking-[0.04em]">NX</span>
            </Blueprint>

            <Text variant="h1" as="h1" className="mb-2 uppercase">
              Sign in
            </Text>

            <Text variant="body" tone="muted" className="mb-[26px]">
              Authentication is handled by your organisation&rsquo;s identity provider. Nix stores
              no passwords.
            </Text>

            <div className="mb-4">
              <label
                htmlFor="organisation"
                className="mb-[5px] block text-xs uppercase tracking-[0.06em] text-muted"
              >
                Organisation
              </label>
              <div className="flex items-stretch border border-divider">
                <input
                  id="organisation"
                  name="organisation"
                  readOnly
                  value={organisation}
                  className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent"
                />
                <span className="inline-flex items-center border-l border-divider bg-surface px-3 text-sm text-muted">
                  .nix.app
                </span>
              </div>
            </div>

            <Button
              variant="primary"
              onClick={onSignIn}
              disabled={isBusy}
              className="min-h-10 w-full justify-center text-sm"
            >
              {isBusy ? 'Redirecting…' : 'Continue with SSO'}
              <Icon icon={ArrowRight} size="sm" />
            </Button>

            {error === null ? (
              <p className="mt-[10px] text-xs text-muted">
                Redirects to {organisation}&rsquo;s IdP (OIDC). Tokens from unregistered issuers are
                rejected.
              </p>
            ) : (
              <p role="alert" className="mt-[10px] text-xs text-accent-text">
                {error}
              </p>
            )}

            <div className="mt-auto flex items-center gap-[14px] pt-7 text-xs text-muted">
              <span className="inline-flex items-center gap-1.5">
                <Icon icon={Lock} size="sm" />
                Single tenant &middot; RLS-isolated
              </span>
              <span className="ml-auto font-mono">v{version}</span>
            </div>
          </section>

          <aside className="flex flex-col bg-surface py-[22px]">
            <div className="border-b border-divider px-[22px] pb-3 text-xs uppercase tracking-[0.08em] text-muted">
              Recent workspaces
            </div>

            {recentWorkspaces.length === 0 ? (
              // Honest empty state rather than invented rows: on a first visit there is nothing to
              // resume, and pretending otherwise is exactly the dishonesty the UI rules forbid.
              <p className="px-[22px] py-4 text-xs text-muted">
                None yet. Workspaces you open will be listed here for next time.
              </p>
            ) : (
              <ul className="flex flex-col">
                {recentWorkspaces.map((workspace) => (
                  <li key={workspace.id}>
                    <button
                      type="button"
                      onClick={onSignIn}
                      className="flex w-full items-center gap-[11px] border-b border-divider px-[22px] py-3 text-left hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      <span className="inline-flex size-[26px] items-center justify-center border border-divider font-heading text-xs">
                        {workspace.initials}
                      </span>
                      <span className="flex flex-col">
                        <span className="text-base font-medium">{workspace.name}</span>
                        <span className="text-xs text-muted">{workspace.openedLabel}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-auto flex flex-col gap-1 px-[22px] pt-4 text-xs text-muted">
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className={
                    serverReachable
                      ? 'inline-block size-[7px] bg-accent'
                      : 'inline-block size-[7px] bg-muted'
                  }
                />
                {serverReachable ? 'Server reachable' : 'Server unreachable'}
              </span>
              <span className="font-mono">{host}</span>
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}

/**
 * The desktop chrome from the design file: three window controls and a centred wordmark.
 *
 * Decorative, so it is hidden from assistive technology - it is a picture of a title bar, not one.
 */
function FauxTitleBar(): ReactNode {
  return (
    <div
      aria-hidden="true"
      className="flex h-[34px] items-center border-b border-divider bg-surface px-[14px]"
    >
      <span className="inline-flex gap-[7px]">
        <span className="size-[10px] border border-muted" />
        <span className="size-[10px] border border-muted" />
        <span className="size-[10px] border border-muted" />
      </span>
      <span className="mx-auto -translate-x-[26px] text-xs uppercase tracking-[0.1em] text-muted">
        Nix
      </span>
    </div>
  );
}
