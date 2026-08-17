import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '../auth/auth-provider';
import type { PropertyDefinition, View } from '../views/core/container-model';

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

/**
 * What a create came back with.
 *
 * An id or a reason, never neither and never both. `null` alone was ambiguous at the call site -
 * it meant "refused", but the reason had gone into the tree's own error and rendered at the foot
 * of the sidebar, so a caller could report that something failed and not what.
 */
export interface CreateOutcome {
  readonly id: string | null;
  readonly refusal: string | null;
}

/**
 * What a {@link WorkspaceTree.remove} or {@link WorkspaceTree.restore} came back with.
 *
 * `null` means it happened; anything else is why it did not. There is no success payload to carry
 * alongside it the way {@link CreateOutcome} carries an id - the caller already knows which item it
 * asked to remove or restore - so a single field says everything a caller needs to decide whether
 * to trust what it was about to claim happened. Before this existed, both calls were fire-and-
 * forget: the caller set state claiming success in the same breath as the request, with the
 * request's own failure only reaching the tree's foot-of-sidebar error, never the caller that had
 * already told somebody the opposite. `rename` and `move` do not follow this pattern yet - both
 * still return `Promise<void>` - which is a real inconsistency, left alone here as a separate,
 * later change rather than folded into this one.
 */
export interface MutationOutcome {
  readonly refusal: string | null;
}

/**
 * Where a reveal got to.
 *
 * `revealing` while the ancestor walk is in flight; then one of the four things it can have found.
 *
 * Each is a different sentence to a reader, which is the whole reason they are not one word.
 * `missing` says a document may be gone, so it is reserved for a server that actually said 404 -
 * a 500, a dropped connection or an expired session are `failed`, which says something went wrong
 * and offers to try again. Telling somebody their document may have been deleted because a proxy
 * hiccupped is a worse lie than saying nothing.
 */
export type RevealOutcome = 'revealing' | 'found' | 'missing' | 'forbidden' | 'failed';

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

  /**
   * What became of a {@link reveal} for one item, or null if none was ever asked for.
   *
   * A screen that opens an item the tree has not loaded has to say something while the walk up
   * its ancestors is in flight, and something different if the walk found nothing. Without this
   * the only honest thing available was "not in this workspace", which is a flat denial that is
   * wrong during the wait and wrong again for an item somebody simply may not see.
   */
  readonly revealOf: (itemId: string) => RevealOutcome | null;

  /** Forgets a settled reveal and walks again. For the one outcome worth another go. */
  readonly retryReveal: (itemId: string) => Promise<void>;

  readonly isCreating: boolean;
  readonly isSaving: boolean;

  readonly toggle: (itemId: string) => Promise<void>;
  readonly expand: (itemId: string) => Promise<void>;
  readonly create: (
    parentId: string | null,
    title: string,
    type?: string,
    properties?: Record<string, unknown>,
  ) => Promise<CreateOutcome>;
  /** Atomically creates a container together with the fields and views assembled by a wizard. */
  readonly createStructured: (setup: {
    readonly parentId: string | null;
    readonly title: string;
    readonly properties: readonly PropertyDefinition[];
    readonly views: readonly View[];
    readonly defaultView: string;
    readonly publishInteractiveFormViewId: string | null;
  }) => Promise<CreateOutcome & { readonly publicUrl?: string | null }>;
  readonly rename: (itemId: string, title: string) => Promise<void>;
  readonly move: (itemId: string, parentId: string | null, afterId: string | null) => Promise<void>;
  readonly remove: (itemId: string) => Promise<MutationOutcome>;
  readonly restore: (itemId: string) => Promise<MutationOutcome>;
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

  // A ref rather than state, because `reveal` has to read it to decide whether to run at all - and
  // reading state inside a callback would mean the callback changed identity every time a reveal
  // settled, which is the loop this exists to stop. The counter beside it is what tells React a
  // render is due, since mutating a ref does not.
  const revealsRef = useRef(new Map<string, RevealOutcome>());
  const [, setRevealTick] = useState(0);
  const bumpReveals = useCallback((): void => {
    setRevealTick((tick) => tick + 1);
  }, []);
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
      // Once per identifier, ever. Without this, an item that cannot be revealed - deleted, or
      // not this caller's to see - is retried by every render that asks, because `find` keeps
      // answering null and nothing remembers having tried. That is a thirty-two request walk per
      // render, and it arrives exactly when somebody opens a stale link.
      // Once per identifier - except after a failure, which is worth another go. Without the
      // first half, an item that cannot be revealed is retried by every render, because `find`
      // keeps answering null and nothing remembers having tried; without the second, one dropped
      // request would leave that item unreachable for the rest of the session.
      const already = revealsRef.current.get(itemId);
      if (already !== undefined && already !== 'failed') {
        return;
      }
      revealsRef.current.set(itemId, 'revealing');
      bumpReveals();

      const found: TreeItem[] = [];
      const expand = new Set<string>();

      const settle = (outcome: RevealOutcome): void => {
        revealsRef.current.set(itemId, outcome);
        bumpReveals();
      };

      try {
        await walk();
      } catch {
        // A dropped connection, a token refresh that failed, anything that rejected rather than
        // answered. Left unhandled this would keep the entry on `revealing` for the rest of the
        // session, and the screen reading from it would say "Finding this item…" forever with no
        // control on it - a dead end reached by a different road than the one this replaced.
        settle('failed');
      }

      return;

      // Walk up from the item, fetching each ancestor. Bounded rather than trusting the chain to
      // terminate: the database forbids cycles, and a client that looped anyway would hang the tab.
      async function walk(): Promise<void> {
        let cursor: string | null = itemId;
        let guard = 32;
        let refusal: RevealOutcome | null = null;

        while (cursor !== null && guard > 0) {
          const response = await request(`/api/v1/items/${cursor}`);
          if (!response.ok) {
            // Deleted, or not this caller's to see. The two are different things to tell somebody -
            // one is gone, the other is theirs to ask about - so which it was is remembered rather
            // than folded into one word.
            //
            // Break rather than return: an ancestor this caller cannot read does not make the item
            // itself unreachable. Whatever the walk has already found is still worth showing, and
            // discarding it would hide an item somebody has every right to open.
            refusal =
              response.status === 403
                ? 'forbidden'
                : response.status === 404
                  ? 'missing'
                  : 'failed';
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
          settle(refusal ?? 'missing');
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

        settle('found');
      }
    },
    [absorb, bumpReveals, fetchChildren, request],
  );

  const retryReveal = useCallback(
    async (itemId: string): Promise<void> => {
      revealsRef.current.delete(itemId);
      bumpReveals();
      await reveal(itemId);
    },
    [bumpReveals, reveal],
  );

  const create = useCallback(
    async (
      parentId: string | null,
      title: string,
      type = 'note',
      properties?: Record<string, unknown>,
    ): Promise<CreateOutcome> => {
      setIsCreating(true);
      try {
        const response = await request(`/api/v1/workspaces/${WORKSPACE_ID}/items`, {
          method: 'POST',
          // Sent explicitly as null rather than omitted, matching parentId. The contract lists it
          // required-and-nullable, and JSON.stringify drops an undefined key entirely - so the
          // published shape and what we actually send would quietly disagree.
          body: JSON.stringify({ type, title, parentId, properties: properties ?? null }),
        });

        if (!response.ok) {
          // The server names which property is wrong and why. Reporting only the status code
          // turned "Status must be one of Todo, Doing, Done" into "(422)", which tells somebody
          // that something failed and nothing about what to change.
          const problem = (await response.json().catch(() => null)) as { detail?: string } | null;
          const refusal =
            problem?.detail ?? `The item could not be created (${String(response.status)}).`;

          // Returned rather than pushed into the tree-wide error, which renders at the foot of the
          // sidebar - a long way from a gesture made inside a view. The caller is standing where
          // the person is looking.
          return { id: null, refusal };
        }

        const created = toItem((await response.json()) as ItemPayload);
        setItems((current) => [...current, created]);

        // A child created inside a collapsed folder would otherwise be invisible, which reads as
        // the creation having failed.
        if (parentId !== null) {
          setExpanded((current) => new Set(current).add(parentId));
        }

        return { id: created.id, refusal: null };
      } finally {
        setIsCreating(false);
      }
    },
    [request],
  );

  const createStructured = useCallback(
    async (setup: {
      readonly parentId: string | null;
      readonly title: string;
      readonly properties: readonly PropertyDefinition[];
      readonly views: readonly View[];
      readonly defaultView: string;
      readonly publishInteractiveFormViewId: string | null;
    }): Promise<CreateOutcome & { readonly publicUrl?: string | null }> => {
      setIsCreating(true);
      try {
        const response = await request(`/api/v1/workspaces/${WORKSPACE_ID}/structured-items`, {
          method: 'POST',
          body: JSON.stringify({
            type: 'note',
            title: setup.title,
            parentId: setup.parentId,
            schema: {
              inherit: true,
              properties: setup.properties.map((property) => ({
                ...property,
                options: property.options.length === 0 ? null : property.options,
              })),
            },
            views: { views: setup.views, default: setup.defaultView },
            publishInteractiveFormViewId: setup.publishInteractiveFormViewId,
          }),
        });
        if (!response.ok) {
          const problem = (await response.json().catch(() => null)) as { detail?: string } | null;
          return {
            id: null,
            refusal: problem?.detail ?? 'This setup could not be created.',
          };
        }

        const result = (await response.json()) as {
          item: ItemPayload;
          publicForm: { url: string | null } | null;
        };
        const created = toItem(result.item);
        setItems((current) => [...current, created]);
        const createdParent = setup.parentId;
        if (createdParent !== null) {
          setExpanded((current) => new Set(current).add(createdParent));
        }
        return { id: created.id, refusal: null, publicUrl: result.publicForm?.url ?? null };
      } catch {
        return {
          id: null,
          refusal: 'This setup could not be sent. Check the connection and try again.',
        };
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
    async (itemId: string): Promise<MutationOutcome> => {
      setIsSaving(true);
      try {
        const response = await request(`/api/v1/items/${itemId}`, { method: 'DELETE' });

        if (!response.ok) {
          const refusal = `The item could not be deleted (${String(response.status)}).`;
          // Kept alongside the return value, not instead of it: this still renders at the foot of
          // the sidebar for anything that reaches this hook without reading the outcome, and the
          // return value is what lets a caller that does read it - `app-shell.tsx`'s `requestDelete`
          // - refuse to report a deletion that never happened.
          setError(refusal);
          return { refusal };
        }

        // Descendants stay in the store and simply stop being reachable, exactly as they do in
        // the database: deletion is a flag on one row, never a cascade.
        setItems((current) => current.filter((item) => item.id !== itemId));
        return { refusal: null };
      } finally {
        setIsSaving(false);
      }
    },
    [request],
  );

  const restore = useCallback(
    async (itemId: string): Promise<MutationOutcome> => {
      setIsSaving(true);
      try {
        const response = await request(`/api/v1/items/${itemId}/restore`, { method: 'POST' });

        if (!response.ok) {
          const refusal = `The item could not be restored (${String(response.status)}).`;
          setError(refusal);
          return { refusal };
        }

        const restored = toItem((await response.json()) as ItemPayload);
        setItems((current) => [...current.filter((item) => item.id !== itemId), restored]);
        return { refusal: null };
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
    revealOf: (itemId) => revealsRef.current.get(itemId) ?? null,
    retryReveal,
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
    createStructured,
    rename,
    move,
    remove,
    restore,
    reload: load,
  };
}
