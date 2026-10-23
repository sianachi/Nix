import { Blueprint, Button, Icon, Text } from '@nix/ui';
import { ArrowRight } from 'lucide-react';
import type { ReactNode } from 'react';

import { selectIsBusy, useSessionStore } from '../auth/session-store';

export interface LandingPageProps {
  /** Starts the redirect to the identity provider. */
  readonly onSignIn: () => void;
  /** Whether this install offers `/demo`. */
  readonly demo: boolean;
}

const FEATURES: readonly { readonly title: string; readonly detail: string }[] = [
  {
    title: 'Notes and collections',
    detail: 'Write notes, then see any collection as a list, board, calendar, timeline or gallery.',
  },
  {
    title: 'Tasks, habits and My Day',
    detail: 'Plan the day from one screen, with habits and synced calendars beside your tasks.',
  },
  {
    title: 'A companion that can act',
    detail: 'Ask the pet, an AI companion, to find, summarise or change things for you.',
  },
  {
    title: 'Publish as a site',
    detail: 'Turn a set of notes into a docs site or a blog without leaving Nix.',
  },
];

/**
 * The front door for an install that turns it on (`landing` in web-config.json): what Nix is, a
 * way in, and the demo. Shown only to an anonymous visitor at `/`; a deep link still gets sign-in.
 */
export function LandingPage({ onSignIn, demo }: LandingPageProps): ReactNode {
  const isBusy = useSessionStore(selectIsBusy);

  return (
    <main className="flex min-h-dvh flex-col bg-background">
      <header className="flex items-center justify-between gap-4 border-b border-divider px-4 py-3 sm:px-8">
        <Blueprint className="inline-flex size-10 items-center justify-center">
          {/* text-primitive-exempt: the wordmark, set as on the sign-in card. */}
          <span className="font-heading text-lg font-semibold tracking-slight">NX</span>
        </Blueprint>
        <Button variant="secondary" onClick={onSignIn} disabled={isBusy}>
          {isBusy ? 'Redirecting…' : 'Sign in'}
        </Button>
      </header>

      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-10 px-4 py-12 sm:px-8 sm:py-20">
        <section className="flex flex-col items-start gap-4">
          <Text variant="h1" as="h1">
            Your notes, tasks and days in one place
          </Text>
          <Text variant="body" as="p" tone="muted" className="max-w-prose">
            Nix is a personal life-OS for people who run their life in one tool. Capture a thought,
            plan the week and review the day, on the desktop or on your phone.
          </Text>
          <div className="flex flex-wrap items-center gap-3">
            {demo ? (
              <Button
                variant="primary"
                onClick={() => {
                  globalThis.location.assign('/demo');
                }}
              >
                Try the demo
                <Icon icon={ArrowRight} size="sm" />
              </Button>
            ) : null}
            <Button variant={demo ? 'secondary' : 'primary'} onClick={onSignIn} disabled={isBusy}>
              {isBusy ? 'Redirecting…' : 'Sign in'}
            </Button>
          </div>
          {demo ? (
            <Text variant="caption" as="p" tone="muted">
              The demo runs in your browser on sample data. Nothing you do there is sent or saved.
            </Text>
          ) : null}
        </section>

        <section aria-labelledby="landing-features">
          <Text variant="h2" as="h2" id="landing-features" className="mb-4">
            What it does
          </Text>
          <ul className="grid gap-6 sm:grid-cols-2">
            {FEATURES.map((feature) => (
              <li key={feature.title} className="flex flex-col gap-1">
                <Text variant="h4" as="h3">
                  {feature.title}
                </Text>
                <Text variant="bodySmall" as="p" tone="muted">
                  {feature.detail}
                </Text>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}
