import { Button, Icon, Text, focusRing } from '@nix/ui';
import { FileText } from 'lucide-react';
import { type ReactNode } from 'react';

import { useSelectedItem } from '../routing/selected-item';
import { useBacklinks } from './use-backlinks';

/**
 * What points at the item being read.
 *
 * **Four states, four sentences.** Loading is not empty, a failed read is not "nothing links
 * here", and a truncated list is not the whole list. Saying any of those wrongly is worse than
 * saying nothing: somebody who is told their document is unreferenced stops looking for the
 * document that references it.
 *
 * **Backlinks lag the document they come from, and the panel says so.** They are extracted when a
 * document is snapshotted - which happens on a cadence and when the last reader closes it - so a
 * link written in another tab a moment ago may genuinely not be here yet. That is a real property
 * of deriving them rather than computing them on read, and hiding it would make the panel look
 * broken instead of behind.
 */

export function BacklinksPane({ itemId }: { readonly itemId: string | null }): ReactNode {
  const { status, backlinks, truncated, retry } = useBacklinks(itemId);
  const { select } = useSelectedItem();

  if (itemId === null) {
    return <Text variant="bodySmall" tone="muted">Open an item to see what links to it.</Text>;
  }

  if (status === 'loading') {
    return <Text variant="bodySmall" tone="muted">Looking for links to this item…</Text>;
  }

  if (status === 'error') {
    return (
      <div className="flex flex-col items-start gap-2">
        <Text variant="bodySmall" tone="muted">
          The links to this item could not be loaded.
        </Text>
        <Button variant="secondary" onClick={retry}>
          Try again
        </Button>
      </div>
    );
  }

  if (backlinks.length === 0) {
    return (
      <Text variant="bodySmall" tone="muted">
        Nothing links here yet. Type <code>[[</code> in another document to make one.
      </Text>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex list-none flex-col gap-1 p-0">
        {backlinks.map((backlink) => (
          <li key={backlink.source.id}>
            <button
              type="button"
              onClick={() => {
                select(backlink.source.id);
              }}
              className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-foreground/7 ${focusRing}`}
            >
              <Icon icon={FileText} size="sm" className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate">{backlink.source.title ?? 'Untitled'}</span>

              {backlink.occurrences > 1 ? (
                // Said only when it is more than once. A "1" beside every row would be a column of
                // ones that means nothing.
                <Text as="span" variant="caption" tone="muted" className="shrink-0">
                  {backlink.occurrences} mentions
                </Text>
              ) : null}
            </button>
          </li>
        ))}
      </ul>

      {truncated ? (
        <Text variant="caption" tone="muted">
          Showing the first {backlinks.length}. There may be more.
        </Text>
      ) : null}

      <Text variant="caption" tone="muted">
        Links appear here once the document holding them has been saved.
      </Text>
    </div>
  );
}
