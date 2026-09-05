import { Button, Icon, Text } from '@nix/ui';
import { RotateCcw, Trash2 } from 'lucide-react';
import { isNixApiError, items as coreItems, type Item } from '@nix/api-client';
import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react';

import { useApiClient } from '../api/api-client-provider';
import { EmptyPanel, ErrorPanel, LoadingPanel } from '../components/states/status-panels';
import { paneScroller } from '../layout/regions';
import { useWorkspace } from '../workspaces/workspace-context';

function Frame({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <div className={`${paneScroller} flex flex-col gap-4 p-4`}>
      <Text variant="h2" as="h1">
        Trash
      </Text>
      {children}
    </div>
  );
}

export function TrashPage(): ReactElement {
  const client = useApiClient();
  const { workspaceId } = useWorkspace();
  const [state, setState] = useState<{
    items: readonly Item[];
    error: string | null;
    loading: boolean;
  }>({ items: [], error: null, loading: true });
  const [restoring, setRestoring] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const found: Item[] = [];
      for await (const item of client.paginate(coreItems.listTrash(workspaceId, 200)))
        found.push(item);
      setState({ items: found, error: null, loading: false });
    } catch {
      setState({ items: [], loading: false, error: 'Trash could not be loaded.' });
    }
  }, [client, workspaceId]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const restore = async (item: Item): Promise<void> => {
    setRestoring(item.id);
    setNotice(null);
    try {
      await client.execute(coreItems.restoreItem(workspaceId, item.id));
      setState((current) => ({
        ...current,
        items: current.items.filter((candidate) => candidate.id !== item.id),
      }));
      try {
        await client.query(coreItems.itemById(item.id), { forceRefresh: true });
        setNotice(`Restored “${item.title || 'Untitled'}”.`);
      } catch (reason) {
        setNotice(
          isNixApiError(reason) && reason.status === 404
            ? `Restored “${item.title || 'Untitled'}”, but it remains hidden because its parent is still in Trash.`
            : `Restored “${item.title || 'Untitled'}”.`,
        );
      }
    } catch {
      setNotice(`“${item.title || 'Untitled'}” could not be restored.`);
    } finally {
      setRestoring(null);
    }
  };
  const purge = async (item: Item): Promise<void> => {
    if (!window.confirm(`Permanently delete “${item.title || 'Untitled'}”? This cannot be undone.`))
      return;
    setRestoring(item.id);
    try {
      await client.execute(coreItems.purgeItem(workspaceId, item.id));
      setState((current) => ({
        ...current,
        items: current.items.filter((candidate) => candidate.id !== item.id),
      }));
      setNotice(`Permanently deleted “${item.title || 'Untitled'}”.`);
    } catch {
      setNotice(`“${item.title || 'Untitled'}” could not be permanently deleted.`);
    } finally {
      setRestoring(null);
    }
  };

  if (state.loading)
    return (
      <Frame>
        <LoadingPanel label="trash" />
      </Frame>
    );
  if (state.error)
    return (
      <Frame>
        <ErrorPanel
          title="Trash could not be loaded"
          detail={state.error}
          action={
            <Button
              onClick={() => {
                void load();
              }}
            >
              Try again
            </Button>
          }
        />
      </Frame>
    );
  if (state.items.length === 0)
    return (
      <Frame>
        <EmptyPanel
          title="Trash is empty"
          detail="Items you delete can be restored here until their retention period ends."
        />
      </Frame>
    );
  return (
    <Frame>
      {notice ? (
        <Text variant="note" as="p" role="status">
          {notice}
        </Text>
      ) : null}
      <ul aria-label="Trash" className="flex flex-col gap-px">
        {state.items.map((item) => (
          <li
            key={item.id}
            className="flex items-center gap-3 rounded-sm px-2 py-2 hover:bg-surface"
          >
            <Icon icon={Trash2} size="sm" className="shrink-0 text-muted" />
            <Text variant="note" as="span" className="min-w-0 flex-1 truncate">
              {item.title || 'Untitled'}
            </Text>
            <Button
              variant="secondary"
              disabled={restoring === item.id}
              onClick={() => {
                void restore(item);
              }}
            >
              <Icon icon={RotateCcw} size="sm" />
              {restoring === item.id ? 'Restoring…' : 'Restore'}
            </Button>
            <Button
              variant="primary"
              disabled={restoring === item.id}
              onClick={() => {
                void purge(item);
              }}
            >
              Delete permanently
            </Button>
          </li>
        ))}
      </ul>
    </Frame>
  );
}
