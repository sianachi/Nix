import { Blueprint, Button, Icon, Text, cn, fieldLabel, focusRing } from '@nix/ui';
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
 * **There is no password field and there never will be.** Authentication is the configured identity
 * provider's job and Nix stores no credentials. A deployment currently serves one organisation,
 * so the screen offers no organisation picker or read-only field that suggests otherwise.
 */

export interface RecentWorkspace {
  readonly id: string;
  readonly name: string;
  readonly initials: string;
  readonly openedLabel: string;
}

export interface LoginPageProps {
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

/**
 * The graph paper the sign-in card sits on, drawn as two gradients.
 *
 * The colour is a role rather than a value: 5% of the accent mixed towards transparent, so the grid
 * follows the ground like everything else on the screen. It used to be written out as an rgb
 * triple, and it was the one colour here that could not follow.
 *
 * **The two lengths stay raw, and should.** 1px is a device hairline - the thinnest rule a screen
 * can draw, and not a quantity the spacing scale has an opinion about. 34px is the tile the design
 * file draws its graph paper at. A background tile is a picture rather than a step of rhythm, and
 * the sheet carries no length for one, so there is no token here to reach for.
 */
const GRAPH_PAPER =
  'bg-[linear-gradient(to_right,var(--grid-rule)_1px,transparent_1px),linear-gradient(to_bottom,var(--grid-rule)_1px,transparent_1px)] [--grid-rule:color-mix(in_srgb,var(--color-accent)_5%,transparent)] bg-[length:34px_34px]'; // design-token-exempt: a 1px hairline and the design file's own 34px tile, neither of which is a spacing step - see above.

export function LoginPage({
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

      <div className={`relative flex flex-1 items-center justify-center ${GRAPH_PAPER} px-6 py-12`}>
        <div
          className="grid w-full max-w-[700px] grid-cols-1 border border-divider bg-background shadow-md md:grid-cols-[400px_300px]" // design-token-exempt: the two column widths are this one screen's proportions, the same kind of value as the panel widths the rule already leaves alone
        >
          <section className="flex flex-col border-divider p-11 md:border-r">
            <Blueprint className="mb-6.5 inline-flex size-15.5 items-center justify-center">
              {/* text-primitive-exempt: the wordmark. Two capitals at the h2 step, opened to
                  `tracking-slight` because a pair of caps set at the heading's own `tracking-tight`
                  reads as one glyph. `<Text variant="h2">` is the right size and the wrong
                  tracking, and tracking is not a prop - see Text.tsx's note on why. */}
              <span className="font-heading text-2xl font-semibold tracking-slight">NX</span>
            </Blueprint>

            <Text variant="h1" as="h1" className="mb-2 uppercase">
              Sign in
            </Text>

            <Text variant="body" tone="muted" className="mb-7.5">
              Continue to your organisation&rsquo;s sign-in service. Nix stores no passwords.
            </Text>

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
              <Text variant="caption" as="p" tone="muted" className="mt-3">
                You will return here after signing in with the configured identity provider.
              </Text>
            ) : (
              <Text variant="caption" as="p" tone="accent" role="alert" className="mt-3">
                {error}
              </Text>
            )}

            <Text
              variant="caption"
              as="div"
              tone="muted"
              className="mt-auto flex items-center gap-4 pt-7"
            >
              <span className="inline-flex items-center gap-1.5">
                <Icon icon={Lock} size="sm" />
                SSO secured &middot; RLS-isolated
              </span>
              <span className="ml-auto font-mono">v{version}</span>
            </Text>
          </section>

          <aside className="flex flex-col bg-surface py-6.5">
            <div className={cn('border-b border-divider px-6.5 pb-3', fieldLabel)}>
              Recent workspaces
            </div>

            {recentWorkspaces.length === 0 ? (
              // Honest empty state rather than invented rows: on a first visit there is nothing to
              // resume, and pretending otherwise is exactly the dishonesty the UI rules forbid.
              <Text variant="caption" as="p" tone="muted" className="px-6.5 py-4">
                None yet. Workspaces you open will be listed here for next time.
              </Text>
            ) : (
              <ul className="flex flex-col">
                {recentWorkspaces.map((workspace) => (
                  <li key={workspace.id}>
                    <button
                      type="button"
                      onClick={onSignIn}
                      className={`flex w-full items-center gap-3 border-b border-divider px-6.5 py-3 text-left hover:bg-accent/10 ${focusRing}`}
                    >
                      {/* text-primitive-exempt: a monogram, not a line of text - a fixed
                          control-sized box whose type is part of the drawn chip. */}
                      <span className="inline-flex size-(--control-sm) items-center justify-center border border-divider font-heading text-xs">
                        {workspace.initials}
                      </span>
                      <span className="flex flex-col">
                        {/* text-primitive-exempt: `bodySmall` at weight 500. Weight is not an axis
                            `<Text>` offers - a variant fixes it - and this row's name is picked
                            out from the timestamp under it by weight alone. */}
                        <span className="text-base font-medium">{workspace.name}</span>
                        <Text variant="caption" as="span" tone="muted">
                          {workspace.openedLabel}
                        </Text>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <Text
              variant="caption"
              as="div"
              tone="muted"
              className="mt-auto flex flex-col gap-1 px-6.5 pt-4"
            >
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className={
                    serverReachable
                      ? 'inline-block size-2 bg-accent'
                      : 'inline-block size-2 bg-muted'
                  }
                />
                {serverReachable ? 'Server reachable' : 'Server unreachable'}
              </span>
              <span className="font-mono">{host}</span>
            </Text>
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
      className="flex h-10 items-center border-b border-divider bg-surface px-4"
    >
      <span className="inline-flex gap-2">
        <span className="size-3 border border-muted" />
        <span className="size-3 border border-muted" />
        <span className="size-3 border border-muted" />
      </span>
      {/* text-primitive-exempt: the drawn title bar's own wordmark, inside an aria-hidden
          picture of a window. `kicker` is this treatment one step down (2xs); at 2xs the four
          letters stop reading as a title bar's title. */}
      <span className="mx-auto -translate-x-7.5 text-xs uppercase tracking-widest text-muted">
        Nix
      </span>
    </div>
  );
}
