import { items as coreItems, isCanceledError, isNixApiError } from '@nix/api-client';
import { Button } from '@nix/ui';
import { useEffect, useState, type ReactNode } from 'react';

import { useApiClient } from '../api/api-client-provider';
import { useHiddenItems } from './use-hidden-items';
import { HiddenItemsList, type HiddenEntry } from './hidden-items-list';

export function HiddenItemsPanel({
  onOpen,
}: {
  readonly onOpen: (itemId: string) => void;
}): ReactNode {
  const visibility = useHiddenItems();
  const [open, setOpen] = useState(false);
  return !visibility.enabled ? null : (
    <div className="flex flex-col gap-2 px-3 py-2">
      <Button
        variant="ghost"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
      >
        Hidden items ({String(visibility.hiddenIds.length)})
      </Button>
      {open ? <HiddenEntries key={visibility.scope} onOpen={onOpen} /> : null}
    </div>
  );
}

function HiddenEntries({ onOpen }: { readonly onOpen: (itemId: string) => void }): ReactNode {
  const client = useApiClient();
  const visibility = useHiddenItems();
  const [loaded, setLoaded] = useState<{
    readonly ids: readonly string[];
    readonly entries: readonly HiddenEntry[];
  } | null>(null);
  const [retry, setRetry] = useState(0);
  const [limit, setLimit] = useState(50);

  useEffect(() => {
    const controller = new AbortController();
    const ids = visibility.hiddenIds;
    const page = ids.slice(0, limit);
    async function load(): Promise<void> {
      const entries: HiddenEntry[] = [];
      // Bound requests: a large personal hidden list must not flood Core on opening this panel.
      for (let offset = 0; offset < page.length; offset += 4) {
        if (controller.signal.aborted) return;
        const batch = await Promise.all(
          page.slice(offset, offset + 4).map(async (id): Promise<HiddenEntry> => {
            try {
              const item = await client.query(coreItems.itemById(id), {
                signal: controller.signal,
                forceRefresh: retry > 0,
              });
              return { id, title: item.title || 'Untitled', failed: false };
            } catch (error) {
              if (isCanceledError(error)) throw error;
              return {
                id,
                title: null,
                failed: !isNixApiError(error) || (error.status !== 403 && error.status !== 404),
              };
            }
          }),
        );
        entries.push(...batch);
        controller.signal.throwIfAborted();
        setLoaded({ ids, entries: [...entries] });
      }
      setLoaded({ ids, entries });
    }
    void load().catch(() => {
      // Cancellation is expected when the person closes the panel or changes workspace.
    });
    return () => {
      controller.abort();
    };
  }, [client, visibility.hiddenIds, retry, limit]);

  const current = loaded?.ids === visibility.hiddenIds ? loaded.entries : [];
  const loading = current.length < Math.min(limit, visibility.hiddenIds.length);
  return (
    <HiddenItemsList
      entries={current}
      count={visibility.hiddenIds.length}
      loading={loading}
      hasMore={limit < visibility.hiddenIds.length}
      saveFailed={visibility.saveFailed}
      onOpen={onOpen}
      onShow={visibility.show}
      onShowAll={visibility.showAll}
      onRetry={() => {
        setRetry(retry + 1);
      }}
      onMore={() => {
        setLimit(limit + 50);
      }}
    />
  );
}
