import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAuth } from '../auth/auth-provider';

/**
 * The workspace tree: the items, their shape, and the writes the shell performs on them.
 *
 * Talks to Core directly with `fetch` rather than through `@nix/api-client`'s cache layer, because
 * the client's descriptor execution wants a configured `NixClient` and this needs one thing: a
 * bearer token on each request. When the app-wide client is wired, this hook is the only place
 * that changes.
 *
 * **Every state the interface can be in is represented separately**, because the interface renders
 * them separately: loading is not empty, and a failed load is not an empty workspace. Collapsing
 * them is how a person ends up staring at "no items" when the request returned a 500.
 *
 * **Children are fetched per folder, on expansion.** The alternative - one request for the whole
 * workspace - is simpler and wrong at the size this is built for: a workspace with ten thousand
 * items would make opening the application a ten-thousand-row download to render twelve.
 */

export interface TreeItem {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly parentId: string | null;

  /**
   * Whether the item has at least one child that is not deleted.
   *
   * What the expand control is drawn from. Every item can hold children, so without this the tree
   * would either offer a control on every row - most of which would expand to nothing - or guess
   * from the item's type, which is what it used to do and why a note could not hold anything.
   */
  readonly hasChildren: boolean;
  readonly seq: number;
  readonly lifecycleState: string;
}

export type TreeStatus = 'loading' | 'ready' | 'error';

export interface WorkspaceTree {
  readonly status: TreeStatus;
  readonly error: string | null;

  /** Every item loaded so far, in no particular order. Use `childrenOf` for display. */
  readonly items: readonly TreeItem[];

  /** The children of a folder, in sibling order, or the roots when given null. */
  readonly childrenOf: (parentId: string | null) => readonly TreeItem[];

  /** Whether a folder's children are on screen. */
  readonly isExpanded: (itemId: string) => boolean;

  /** Whether a folder's children are still being fetched. */
  readonly isLoadingChildren: (itemId: string) => boolean;

  /** The chain from the workspace root down to an item, the item last. */
  readonly breadcrumbs: (itemId: string) => readonly TreeItem[];

  readonly find: (itemId: string) => TreeItem | null;

  /**
   * Loads an item and its ancestors, expanding the chain so it is visible in the tree.
   *
   * What makes a shared link to a nested note work. The tree loads roots and then children on
   * expansion, so an item three folders down is not in it when somebody arrives on a link naming
   * that item - and the screen would otherwise say "select a note from the tree" about the note it
   * was asked for.
   */
  readonly reveal: (itemId: string) => Promise<void>;

  readonly isCreating: boolean;
  readonly isSaving: boolean;

  readonly toggle: (itemId: string) => Promise<void>;
  readonly expand: (itemId: string) => Promise<void>;
  readonly create: (
    parentId: string | null,
    title: string,
    type?: string,
  ) => Promise<string | null>;
  readonly rename: (itemId: string, title: string) => Promise<void>;
  readonly move: (itemId: string, parentId: string | null, afterId: string | null) => Promise<void>;
  readonly remove: (itemId: string) => Promise<void>;
  readonly restore: (itemId: string) => Promise<void>;
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
  readonly parentId: string | null;
  readonly hasChildren: boolean;
  readonly seq: number;
  readonly lifecycleState: string;
}

function toItem(payload: ItemPayload): TreeItem {
  return {
    id: payload.id,
    title: payload.title,
    type: payload.type,
    parentId: payload.parentId,
    hasChildren: payload.hasChildren,
    seq: payload.seq,
    lifecycleState: payload.lifecycleState,
  };
}

export function useWorkspaceTree(): WorkspaceTree {
  const { getAccessToken } = useAuth();

  const [status, setStatus] = useState<TreeStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<readonly TreeItem[]>([]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [loadingChildren, setLoadingChildren] = useState<ReadonlySet<string>>(new Set());
  const [isCreating, setIsCreating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

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

  const fetchChildren = useCallback(
    async (parentId: string | null): Promise<readonly TreeItem[] | null> => {
      const query = parentId === null ? '' : `?parentId=${parentId}`;
      const response = await request(`/api/v1/workspaces/${WORKSPACE_ID}/items${query}`);

      if (!response.ok) {
        // The stable `code` is what to branch on; the detail is for a person to read.
        const problem = (await response.json().catch(() => null)) as { detail?: string } | null;
        setError(problem?.detail ?? `The tree could not be loaded (${String(response.status)}).`);
        return null;
      }

      const page = (await response.json()) as { items: ItemPayload[] };
      return page.items.map(toItem);
    },
    [request],
  );

  /**
   * Replaces one parent's children wholesale.
   *
   * Merging would leave an item that was deleted elsewhere on screen forever, because a merge has
   * no way to learn that something is gone - only that it was not mentioned.
   */
  const absorb = useCallback((parentId: string | null, children: readonly TreeItem[]): void => {
    setItems((current) => [...current.filter((item) => item.parentId !== parentId), ...children]);
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setStatus('loading');
    setError(null);

    try {
      const roots = await fetchChildren(null);
      if (roots === null) {
        setStatus('error');
        return;
      }

      setItems(roots);
      setExpanded(new Set());
      setStatus('ready');
    } catch {
      setError('Core could not be reached.');
      setStatus('error');
    }
  }, [fetchChildren]);

  useEffect(() => {
    // queueMicrotask so the first setState lands after the effect returns rather than during it,
    // which is what stops the initial render cascading.
    queueMicrotask(() => {
      void load();
    });
  }, [load]);

  const expand = useCallback(
    async (itemId: string): Promise<void> => {
      setExpanded((current) => new Set(current).add(itemId));
      setLoadingChildren((current) => new Set(current).add(itemId));

      try {
        const children = await fetchChildren(itemId);
        if (children !== null) {
          absorb(itemId, children);
        }
      } finally {
        setLoadingChildren((current) => {
          const next = new Set(current);
          next.delete(itemId);
          return next;
        });
      }
    },
    [absorb, fetchChildren],
  );

  const toggle = useCallback(
    async (itemId: string): Promise<void> => {
      if (expanded.has(itemId)) {
        setExpanded((current) => {
          const next = new Set(current);
          next.delete(itemId);
          return next;
        });
        return;
      }

      await expand(itemId);
    },
    [expand, expanded],
  );

  const reveal = useCallback(
    async (itemId: string): Promise<void> => {
      const found: TreeItem[] = [];
      const expand = new Set<string>();

      // Walk up from the item, fetching each ancestor. Bounded rather than trusting the chain to
      // terminate: the database forbids cycles, and a client that looped anyway would hang the tab.
      let cursor: string | null = itemId;
      let guard = 32;

      while (cursor !== null && guard > 0) {
        const response = await request(`/api/v1/items/${cursor}`);
        if (!response.ok) {
          // A link to something that has been deleted, or that this caller may not see. Both are
          // reported the same way by Core, and both mean the same thing here: there is nothing to
          // reveal, and the screen's own empty state is the honest answer.
          break;
        }

        const loaded = toItem((await response.json()) as ItemPayload);
        found.push(loaded);

        if (loaded.parentId !== null) {
          expand.add(loaded.parentId);
        }

        cursor = loaded.parentId;
        guard -= 1;
      }

      if (found.length === 0) {
        return;
      }

      setItems((current) => {
        const known = new Set(current.map((entry) => entry.id));
        return [...current, ...found.filter((entry) => !known.has(entry.id))];
      });

      setExpanded((current) => new Set([...current, ...expand]));

      // The ancestors are now present but their other children are not, so a revealed note would
      // appear as its parent's only child. Fetching each level puts its siblings back.
      for (const parentId of expand) {
        const siblings = await fetchChildren(parentId);
        if (siblings !== null) {
          absorb(parentId, siblings);
        }
      }
    },
    [absorb, fetchChildren, request],
  );

  const create = useCallback(
    async (parentId: string | null, title: string, type = 'note'): Promise<string | null> => {
      setIsCreating(true);
      try {
        const response = await request(`/api/v1/workspaces/${WORKSPACE_ID}/items`, {
          method: 'POST',
          body: JSON.stringify({ type, title, parentId }),
        });

        if (!response.ok) {
          setError(`The item could not be created (${String(response.status)}).`);
          return null;
        }

        const created = toItem((await response.json()) as ItemPayload);
        setItems((current) => [...current, created]);

        // A child created inside a collapsed folder would otherwise be invisible, which reads as
        // the creation having failed.
        if (parentId !== null) {
          setExpanded((current) => new Set(current).add(parentId));
        }

        return created.id;
      } finally {
        setIsCreating(false);
      }
    },
    [request],
  );

  const rename = useCallback(
    async (itemId: string, title: string): Promise<void> => {
      setIsSaving(true);
      try {
        const response = await request(`/api/v1/items/${itemId}`, {
          method: 'PATCH',
          body: JSON.stringify({ title }),
        });

        if (!response.ok) {
          setError(`The title could not be saved (${String(response.status)}).`);
          return;
        }

        const updated = toItem((await response.json()) as ItemPayload);
        setItems((current) => current.map((item) => (item.id === itemId ? updated : item)));
      } finally {
        setIsSaving(false);
      }
    },
    [request],
  );

  const move = useCallback(
    async (itemId: string, parentId: string | null, afterId: string | null): Promise<void> => {
      setIsSaving(true);
      try {
        const response = await request(`/api/v1/items/${itemId}/move`, {
          method: 'POST',
          body: JSON.stringify({ parentId, afterId }),
        });

        if (!response.ok) {
          const problem = (await response.json().catch(() => null)) as {
            code?: string;
            detail?: string;
          } | null;

          // The cycle refusal is the one a person can act on - they dropped a folder into itself -
          // so it is worth saying plainly rather than as a status code.
          setError(
            problem?.code === 'items.move_would_create_cycle'
              ? 'An item cannot be moved inside itself.'
              : (problem?.detail ?? `The item could not be moved (${String(response.status)}).`),
          );
          return;
        }

        const moved = toItem((await response.json()) as ItemPayload);
        setItems((current) => current.map((item) => (item.id === itemId ? moved : item)));

        // The destination's order changed for every sibling, not just the moved item, so its
        // children are re-read rather than patched.
        const siblings = await fetchChildren(parentId);
        if (siblings !== null) {
          absorb(parentId, siblings);
        }
      } finally {
        setIsSaving(false);
      }
    },
    [absorb, fetchChildren, request],
  );

  const remove = useCallback(
    async (itemId: string): Promise<void> => {
      setIsSaving(true);
      try {
        const response = await request(`/api/v1/items/${itemId}`, { method: 'DELETE' });

        if (!response.ok) {
          setError(`The item could not be deleted (${String(response.status)}).`);
          return;
        }

        // Descendants stay in the store and simply stop being reachable, exactly as they do in
        // the database: deletion is a flag on one row, never a cascade.
        setItems((current) => current.filter((item) => item.id !== itemId));
      } finally {
        setIsSaving(false);
      }
    },
    [request],
  );

  const restore = useCallback(
    async (itemId: string): Promise<void> => {
      setIsSaving(true);
      try {
        const response = await request(`/api/v1/items/${itemId}/restore`, { method: 'POST' });

        if (!response.ok) {
          setError(`The item could not be restored (${String(response.status)}).`);
          return;
        }

        const restored = toItem((await response.json()) as ItemPayload);
        setItems((current) => [...current.filter((item) => item.id !== itemId), restored]);
      } finally {
        setIsSaving(false);
      }
    },
    [request],
  );

  const byParent = useMemo(() => {
    const index = new Map<string | null, TreeItem[]>();
    for (const item of items) {
      const siblings = index.get(item.parentId) ?? [];
      siblings.push(item);
      index.set(item.parentId, siblings);
    }

    for (const siblings of index.values()) {
      siblings.sort((left, right) => left.seq - right.seq);
    }

    return index;
  }, [items]);

  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);

  const childrenOf = useCallback(
    (parentId: string | null): readonly TreeItem[] => byParent.get(parentId) ?? [],
    [byParent],
  );

  const breadcrumbs = useCallback(
    (itemId: string): readonly TreeItem[] => {
      const chain: TreeItem[] = [];
      let cursor = byId.get(itemId) ?? null;

      // Bounded by the number of loaded items rather than trusting the chain to terminate: the
      // database forbids cycles, and a client that looped anyway would hang the tab.
      let guard = byId.size + 1;
      while (cursor !== null && guard > 0) {
        chain.unshift(cursor);
        cursor = cursor.parentId === null ? null : (byId.get(cursor.parentId) ?? null);
        guard -= 1;
      }

      return chain;
    },
    [byId],
  );

  return {
    status,
    error,
    items,
    childrenOf,
    isExpanded: (itemId) => expanded.has(itemId),
    isLoadingChildren: (itemId) => loadingChildren.has(itemId),
    breadcrumbs,
    reveal,
    find: (itemId) => byId.get(itemId) ?? null,
    isCreating,
    isSaving,
    toggle,
    expand,
    create,
    rename,
    move,
    remove,
    restore,
    reload: load,
  };
}
