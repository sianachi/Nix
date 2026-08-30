import { Button, Text } from '@nix/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useOutletContext } from 'react-router';

import type { ShellContext } from '../shell/shell-context';
import { dailyNoteLabel, dailyNoteTitle } from './daily-note';

/**
 * Opens today's regular Nix note, creating it when needed.
 *
 * The route is stable (`/daily`) while the resulting item address remains shareable. Once the item
 * exists this page replaces itself with that address, so Back returns to the place the person came
 * from instead of to a transient creation screen.
 */
export function DailyNotePage(): ReactNode {
  const { tree } = useOutletContext<ShellContext>();
  const navigate = useNavigate();
  const today = dailyNoteTitle();
  const label = dailyNoteLabel();
  const attempted = useRef<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    if (tree.status !== 'ready' || attempted.current === today) {
      return;
    }

    attempted.current = today;
    void tree.openDailyNote(today).then((outcome) => {
      if (outcome.id !== null) {
        void navigate(`/?item=${encodeURIComponent(outcome.id)}`, { replace: true });
        return;
      }

      setRefusal(outcome.refusal ?? "Today's note could not be opened.");
    });
  }, [navigate, today, tree]);

  if (tree.status === 'error') {
    return (
      <section className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <Text variant="h2" as="h1">
          Today&rsquo;s note could not be opened
        </Text>
        <Text variant="note" tone="muted" role="alert" className="max-w-md">
          {tree.error ?? 'The workspace could not be loaded.'}
        </Text>
        <Button
          variant="secondary"
          onClick={() => {
            attempted.current = null;
            void tree.reload();
          }}
        >
          Try again
        </Button>
      </section>
    );
  }

  if (refusal !== null) {
    return (
      <section className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <Text variant="h2" as="h1">
          Today&rsquo;s note could not be opened
        </Text>
        <Text variant="note" tone="muted" role="alert" className="max-w-md">
          {refusal}
        </Text>
        <Button
          variant="secondary"
          onClick={() => {
            attempted.current = null;
            setRefusal(null);
          }}
        >
          Try again
        </Button>
      </section>
    );
  }

  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
      <Text variant="h2" as="h1">
        Opening today&rsquo;s note
      </Text>
      <Text variant="note" tone="muted">
        {label}
      </Text>
    </section>
  );
}
