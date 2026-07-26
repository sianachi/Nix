import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '../auth/auth-provider';

/**
 * The workspace tree, and the two writes the editor screen performs.
 *
 * Talks to Core directly with `fetch` rather than through `@nix/api-client`'s cache layer, because
 * the client's descriptor execution wants a configured `NixClient` and this screen needs one thing:
 * a bearer token on each request. When the app-wide client is wired, this hook is the only place
 * that changes.
 *
 * Every state the screen can be in is represented here, separately, because the screen renders them
 * separately: loading is not the same as empty, and a failed load is not the same as an empty
 * workspace. Collapsing them is how a person ends up staring at "no items" when the request 500ed.
 */

export interface TreeItem {
  readonly id: string;
  readonly title: string;
  readonly type: string;
}

export type TreeStatus = 'loading' | 'ready' | 'error';

export interface WorkspaceTree {
  readonly status: TreeStatus;
  readonly items: readonly TreeItem[];
  readonly error: string | null;
  readonly selected: TreeItem | null;
  readonly isCreating: boolean;
  readonly isRenaming: boolean;
  readonly lastSavedAt: string | null;
  readonly select: (itemId: string) => void;
  readonly createNote: (title: string) => Promise<void>;
  readonly rename: (itemId: string, title: string) => Promise<void>;
  readonly reload: () => Promise<void>;
}

/** The workspace the shell is scoped to. Real switching arrives with the workspace picker. */
function readWorkspaceId(): string {
  const configured: unknown = import.meta.env.VITE_WORKSPACE_ID;
  return typeof configured === 'string' && configured.length > 0
    ? configured
    : 'a1000000-0000-4000-8000-000000000001';
}

const WORKSPACE_ID = readWorkspaceId();

interface ItemPayload {
  readonly id: string;
  readonly title: string;
  readonly type: string;
}

export function useWorkspaceTree(): WorkspaceTree {
  const { getAccessToken } = useAuth();

  const [status, setStatus] = useState<TreeStatus>('loading');
  const [items, setItems] = useState<readonly TreeItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);

  const request = useCallback(
    async (path: string, init?: RequestInit): Promise<Response> => {
      const token = await getAccessToken();
      return fetch(path, {
        ...init,
        headers: {
          'content-type': 'application/json',
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        },
      });
    },
    [getAccessToken],
  );

  const load = useCallback(async (): Promise<void> => {
    setStatus('loading');
    setError(null);

    try {
      const response = await request(`/api/v1/workspaces/${WORKSPACE_ID}/items`);

      if (!response.ok) {
        // The stable `code` is what to branch on; the message is for a person to read.
        const problem = (await response.json().catch(() => null)) as { detail?: string } | null;
        setError(problem?.detail ?? `The tree could not be loaded (${String(response.status)}).`);
        setStatus('error');
        return;
      }

      const page = (await response.json()) as { items: ItemPayload[] };
      setItems(page.items.map((item) => ({ id: item.id, title: item.title, type: item.type })));
      setStatus('ready');
    } catch {
      setError('Core could not be reached.');
      setStatus('error');
    }
  }, [request]);

  useEffect(() => {
    // queueMicrotask so the first setState lands after the effect returns rather than during it,
    // which is what stops the initial render cascading.
    queueMicrotask(() => {
      void load();
    });
  }, [load]);

  const createNote = useCallback(
    async (title: string): Promise<void> => {
      setIsCreating(true);
      try {
        const response = await request(`/api/v1/workspaces/${WORKSPACE_ID}/items`, {
          method: 'POST',
          body: JSON.stringify({ type: 'note', title, parentId: null }),
        });

        if (!response.ok) {
          setError(`The note could not be created (${String(response.status)}).`);
          setStatus('error');
          return;
        }

        const created = (await response.json()) as ItemPayload;
        setItems((current) => [
          ...current,
          { id: created.id, title: created.title, type: created.type },
        ]);
        setSelectedId(created.id);
      } finally {
        setIsCreating(false);
      }
    },
    [request],
  );

  const rename = useCallback(
    async (itemId: string, title: string): Promise<void> => {
      setIsRenaming(true);
      try {
        const response = await request(`/api/v1/items/${itemId}`, {
          method: 'PATCH',
          body: JSON.stringify({ title }),
        });

        if (!response.ok) {
          setError(`The title could not be saved (${String(response.status)}).`);
          return;
        }

        const updated = (await response.json()) as ItemPayload;
        setItems((current) =>
          current.map((item) => (item.id === itemId ? { ...item, title: updated.title } : item)),
        );
        setLastSavedAt(new Date().toLocaleTimeString());
      } finally {
        setIsRenaming(false);
      }
    },
    [request],
  );

  return {
    status,
    items,
    error,
    selected: items.find((item) => item.id === selectedId) ?? null,
    isCreating,
    isRenaming,
    lastSavedAt,
    select: setSelectedId,
    createNote,
    rename,
    reload: load,
  };
}
