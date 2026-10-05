import { Button, Text } from '@nix/ui';
import type { ReactNode } from 'react';

export interface HiddenEntry {
  readonly id: string;
  readonly title: string | null;
  readonly failed: boolean;
}

export function HiddenItemsList({
  entries,
  count,
  loading,
  hasMore,
  saveFailed,
  onOpen,
  onShow,
  onShowAll,
  onRetry,
  onMore,
}: {
  readonly entries: readonly HiddenEntry[];
  readonly count: number;
  readonly loading: boolean;
  readonly hasMore: boolean;
  readonly saveFailed: boolean;
  readonly onOpen: (id: string) => void;
  readonly onShow: (id: string, title: string) => void;
  readonly onShowAll: () => void;
  readonly onRetry: () => void;
  readonly onMore: () => void;
}): ReactNode {
  return (
    <section
      aria-label="Hidden items"
      className="flex flex-col gap-2 rounded-md border border-divider p-3"
    >
      <Text variant="caption" tone="muted">
        Hidden for you in this workspace and browser. Items remain saved. Direct links can still
        open them. Hiding a parent also hides its branch in the sidebar.
      </Text>
      {saveFailed ? (
        <Text as="p" role="alert" variant="caption">
          Your browser could not save this preference. It lasts until this page reloads.
        </Text>
      ) : null}
      {count === 0 ? (
        <Text variant="note">No hidden items.</Text>
      ) : (
        <>
          <Button variant="secondary" onClick={onShowAll}>
            Show all hidden items
          </Button>
          <Button variant="ghost" onClick={onRetry}>
            Reload hidden items
          </Button>
          {loading ? (
            <Text role="status" variant="note">
              Loading hidden items…
            </Text>
          ) : null}
          {entries.some((entry) => entry.failed) ? (
            <Text as="p" role="alert" variant="caption">
              Some items could not be loaded. Try reloading in a moment. Your hidden choices are
              kept.
            </Text>
          ) : null}
          <ul className="flex max-h-96 flex-col gap-2 overflow-y-auto">
            {entries.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center gap-1">
                {entry.title === null ? (
                  <Text as="span" variant="caption">
                    {entry.failed ? 'Could not load item' : 'Unavailable item'}
                  </Text>
                ) : (
                  <Button
                    variant="ghost"
                    className="min-w-0 flex-1 justify-start"
                    onClick={() => {
                      onOpen(entry.id);
                    }}
                  >
                    {entry.title}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  aria-label={
                    entry.title === null
                      ? 'Remove unavailable item from hidden list'
                      : `Show ${entry.title} again`
                  }
                  onClick={() => {
                    onShow(entry.id, entry.title ?? 'Item');
                  }}
                >
                  {entry.title === null ? 'Remove' : 'Show'}
                </Button>
              </li>
            ))}
          </ul>
          {!loading && hasMore ? (
            <Button variant="secondary" onClick={onMore}>
              Load more hidden items
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}
