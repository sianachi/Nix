import { Blueprint, Button, Icon, Text } from '@nix/ui';
import { ArrowRight } from 'lucide-react';
import { type ReactNode } from 'react';

import { selectIsBusy, useSessionStore } from '../auth/session-store';

export interface LoginPageProps {
  /** Starts the redirect to the identity provider. */
  readonly onSignIn: () => void;
  /** Whether the API answered its liveness probe. */
  readonly serverReachable?: boolean;
  /** The host the client is configured against. */
  readonly host?: string;
  /** Why the last attempt failed, when one did. */
  readonly error?: string | null;
}

const GRAPH_PAPER =
  'bg-[linear-gradient(to_right,var(--grid-rule)_1px,transparent_1px),linear-gradient(to_bottom,var(--grid-rule)_1px,transparent_1px)] [--grid-rule:color-mix(in_srgb,var(--color-accent)_5%,transparent)] bg-[length:34px_34px]'; // design-token-exempt: a 1px hairline and the design file's own 34px tile, neither of which is a spacing step - see above.

export function LoginPage({ onSignIn, error = null }: LoginPageProps): ReactNode {
  const isBusy = useSessionStore(selectIsBusy);

  return (
    <main className="flex min-h-dvh flex-col bg-background">
      <div className={`relative flex flex-1 items-center justify-center ${GRAPH_PAPER} px-6 py-12`}>
        <div
          className="w-full max-w-[400px] border border-divider bg-background shadow-md" // design-token-exempt: the card width is this one screen's proportion, the same kind of value as the panel widths the rule already leaves alone
        >
          <section className="flex flex-col p-11">
            <Blueprint className="mb-6.5 inline-flex size-15.5 items-center justify-center">
              <span className="font-heading text-2xl font-semibold tracking-slight">NX</span>
            </Blueprint>

            <Text variant="h1" as="h1" className="mb-2 uppercase">
              Sign in
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

            {error !== null && (
              <Text variant="caption" as="p" tone="accent" role="alert" className="mt-3">
                {error}
              </Text>
            )}
          </section>
        </div>
      </div>
    </main>
  );


}
