import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ZodType } from 'zod';

import { useAuth } from '../../auth/auth-provider';
import { decorateItems, keepComputed } from '../../properties/computed';
import {
  ContainerViewsSchema,
  EffectiveSchemaSchema,
  ItemSchema,
  type ContainerViews,
  type EffectiveSchema,
  type Item,
  type PropertyDefinition,
  type View,
} from './container-model';

/** A schema as an editor holds it: the properties this container declares, and whether it inherits. */
export interface SchemaDraft {
  readonly properties: readonly PropertyDefinition[];
  readonly inherit: boolean;
}

/**
 * Everything a container needs to be looked at: its schema, its views, and its children.
 *
 * One hook rather than three, because a view cannot render until all three have arrived and three
 * hooks would give the screen eight loading states to reason about instead of one.
 *
 * **Every state is represented separately.** Loading is not empty, and a failed load is not an
 * empty item - which is exactly the distinction a view has to draw, since an empty board and a
 * broken board look identical if you let them.
 */

export type ContainerStatus = 'loading' | 'ready' | 'error';

export interface ContainerData {
  /**
   * The item whose container this is - what the hook was asked to load - or null at a workspace
   * root. Carried so a view whose data is not the children (the query view runs its own item's
   * stored filters) can name the item without reaching into the URL.
   */
  readonly itemId: string | null;

  readonly status: ContainerStatus;
  readonly error: string | null;
  readonly schema: EffectiveSchema | null;
  readonly views: ContainerViews | null;
  readonly children: readonly Item[];

  /**
   * Makes a child of this container, optionally with values already set.
   *
   * Returns the reason it was refused, or null when it was made.
   *
   * **Not implemented here.** The item tree already owns creation, and it does two things a second
   * implementation would get wrong: it puts the new item into the store the sidebar reads, and it
   * expands the parent so a child made inside a collapsed item is not invisible. So the screen
   * wires this to `tree.create`, and there is one create path rather than two that drift.
   */
  readonly create: (title: string, properties?: Record<string, unknown>) => Promise<string | null>;

  /**
   * Writes property values onto one child and refreshes it in place.
   *
   * Returns the reason it was refused, or null when it was stored - the same shape every other
   * mutation here returns, and for the same reason: the caller frequently has somewhere better to
   * put the refusal than the view does. A cell that was edited can say so in the cell; a card that
   * was dragged cannot, because nobody awaits a gesture.
   *
   * **Two channels, deliberately.** `writeError` below is the drag channel - a refusal for a caller
   * that fired and forgot. This return value is the awaited-edit channel. A caller uses one or the
   * other and never both: rendering both is two banners for one failure.
   */
  readonly setProperties: (
    itemId: string,
    properties: Record<string, unknown>,
  ) => Promise<string | null>;

  /**
   * Writes property values onto many children as one gesture, and answers for the whole gesture.
   *
   * The spreadsheet view's paste, fill and clear land here: one optimistic pass over the children
   * rather than one per row, requests issued with bounded concurrency rather than all at once, and
   * one reconciling pass at the end that keeps the rows the server took and puts back only the
   * rows it refused. The per-row `setProperties` above cannot do any of that - N calls in one tick
   * share one closure snapshot, so the first refusal used to revert every row in the gesture,
   * including the ones the server had already stored.
   *
   * Refuses a plan larger than {@link MAXIMUM_PLAN_WRITES} outright, with a sentence naming the
   * ceiling: a bigger gesture is a bulk operation the server should own, not a request storm.
   */
  readonly setPropertiesMany: (writes: readonly PlanWrite[]) => Promise<PlanOutcome>;

  /**
   * Replaces the schema this container declares.
   *
   * Returns the reason it was refused, or null when it was stored. A caller needs the reason
   * rather than a boolean: the server names which property is wrong and a form has to put that in
   * front of somebody, which "false" cannot do.
   */
  readonly setSchema: (schema: SchemaDraft) => Promise<string | null>;

  /**
   * Replaces the views this container offers, in switcher order.
   *
   * The default is carried across untouched unless it is passed, so an edit that was not about
   * which view opens does not quietly reset it.
   */
  readonly setViews: (
    views: readonly View[],
    defaultView?: string | null,
  ) => Promise<string | null>;

  /** Atomically appends fields and views assembled by the guided setup studio. */
  readonly appendViewSetup: (
    properties: readonly PropertyDefinition[],
    views: readonly View[],
    makeDefault: boolean,
    publishInteractiveFormViewId?: string | null,
  ) => Promise<string | null>;

  /** Atomically replaces one guided view setup while preserving unrelated views. */
  readonly replaceViewSetup: (
    originalViewId: string,
    properties: readonly PropertyDefinition[],
    views: readonly View[],
    publishInteractiveFormViewId?: string | null,
  ) => Promise<string | null>;

  /**
   * Remembers which view opens, when somebody deliberately switches to it.
   *
   * Never called for a URL that merely arrived carrying `?view=`. See the implementation for why
   * that distinction is the whole of this feature's risk.
   */
  readonly setDefaultView: (viewId: string) => Promise<string | null>;

  /**
   * The last property write that failed, for a view to report without losing the item.
   *
   * The drag channel: a gesture nobody awaits still has to be answered somewhere, and a card that
   * has already snapped back to its old column is not a place to put a sentence. A view whose edits
   * *are* awaited - the list's cells - reads the return value instead and leaves this alone.
   */
  readonly writeError: string | null;

  /**
   * Whether the children shown are only the first pages of a larger container.
   *
   * `load` pages through the children endpoint until it is exhausted or {@link MAXIMUM_CHILDREN}
   * is reached; past that, this is true and a view must say the list is partial. A count asserted
   * over a truncated list - a grid's `aria-rowcount`, a filtered-empty state's total - is a claim
   * about items that were never loaded.
   */
  readonly truncated: boolean;

  readonly reload: () => Promise<void>;
}

/** One row's worth of a bulk write: the item, and the property changes going to it together. */
export interface PlanWrite {
  readonly itemId: string;

  /** How the row is named in the outcome's sentences - its title, since an id names nothing. */
  readonly label: string;

  readonly properties: Record<string, unknown>;
}

/** One refused or failed row of a bulk write, named so a sentence can say which row. */
export interface PlanRefusal {
  readonly label: string;
  readonly reason: string;
}

/** What a bulk write did, for the one notice a view renders about it. */
export interface PlanOutcome {
  /** Rows the server stored. */
  readonly saved: number;

  /** Rows the server refused or that could not be sent, each put back as it was. */
  readonly refused: readonly PlanRefusal[];
}

/**
 * The most rows one gesture may write.
 *
 * A ceiling rather than a queue: past this, the honest answer is that the gesture is a bulk
 * operation the server should own end to end, and letting it run as a request storm would hold a
 * connection pool for minutes with no way to cancel.
 */
export const MAXIMUM_PLAN_WRITES = 1000;

/** How many requests of one plan are in flight at once. */
const PLAN_CONCURRENCY = 6;

/**
 * The most children `load` pages in before reporting the container truncated.
 *
 * Twenty pages at the server's 200-per-page ceiling. Views window their rendering, so the cost of
 * a large container is memory and parse time rather than DOM - but it is not free, and a container
 * past this size needs server-side querying rather than a bigger client buffer.
 */
export const MAXIMUM_CHILDREN = 4000;

/** The server's own page ceiling (`CursorPaging.MaximumPageSize`), asked for explicitly. */
const PAGE_SIZE = 200;

function readWorkspaceId(): string {
  const configured: unknown = import.meta.env.VITE_WORKSPACE_ID;
  return typeof configured === 'string' && configured.length > 0
    ? configured
    : 'a1000000-0000-4000-8000-000000000001';
}

const WORKSPACE_ID = readWorkspaceId();

/**
 * How a container makes a child.
 *
 * Supplied by the screen rather than built here, because creation belongs to the item tree - see
 * `ContainerData.create`.
 */
export type CreateChild = (
  title: string,
  properties?: Record<string, unknown>,
) => Promise<string | null>;

export function useContainer(containerId: string | null, createChild?: CreateChild): ContainerData {
  const { getAccessToken } = useAuth();

  const [status, setStatus] = useState<ContainerStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [schema, storeSchema] = useState<EffectiveSchema | null>(null);
  const [views, storeViews] = useState<ContainerViews | null>(null);
  const [children, setChildren] = useState<readonly Item[]>([]);
  const [truncated, setTruncated] = useState(false);
  const defaultViewWrite = useRef(0);
  const activeLoad = useRef<AbortController | null>(null);

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
    activeLoad.current?.abort();
    const controller = new AbortController();
    activeLoad.current = controller;
    setStatus('loading');
    setError(null);

    try {
      const basePath =
        containerId === null
          ? `/api/v1/workspaces/${WORKSPACE_ID}/items?limit=${String(PAGE_SIZE)}`
          : `/api/v1/workspaces/${WORKSPACE_ID}/items?parentId=${containerId}&limit=${String(PAGE_SIZE)}`;

      // In parallel: three independent reads, and the screen needs all three before it can draw
      // anything. Sequencing them would make opening an item three round trips deep. The children
      // read is only the first page here; the rest are paged in below.
      const [childrenResponse, schemaResponse, viewsResponse] = await Promise.all([
        request(basePath, { signal: controller.signal }),
        containerId === null
          ? Promise.resolve(null)
          : request(`/api/v1/items/${containerId}/schema`, { signal: controller.signal }),
        containerId === null
          ? Promise.resolve(null)
          : request(`/api/v1/items/${containerId}/views`, { signal: controller.signal }),
      ]);

      // Paged until exhausted rather than one default page. The endpoint answers 50 items unless
      // asked, and every view here draws "the children" - a grid publishing aria-rowcount, a
      // filtered-empty state naming a total. A view asserting a count over one silent page of a
      // larger container would be claiming to have seen items it never loaded. Past
      // MAXIMUM_CHILDREN the list is reported truncated instead, and the views say so.
      const loaded: Item[] = [];
      let response = childrenResponse;
      let partial = false;

      for (;;) {
        if (!response.ok) {
          const problem = (await response.json().catch(() => null)) as {
            detail?: string;
          } | null;
          setError(
            problem?.detail ??
              `This item\u2019s contents could not be loaded (${String(response.status)}).`,
          );
          setStatus('error');
          return;
        }

        const page = (await response.json()) as { items: unknown[]; nextCursor?: string | null };
        const parsed = page.items.map((item) => ItemSchema.safeParse(item));

        const bad = parsed.find((result) => !result.success);
        if (bad !== undefined) {
          // A parse failure is telemetry, not a silent fallback: it means the contract moved and
          // this build did not.
          console.warn('An item did not match the contract:', bad.error.message);
          setError('This item\u2019s contents could not be read.');
          setStatus('error');
          return;
        }

        loaded.push(...parsed.flatMap((result) => (result.success ? [result.data] : [])));

        const cursor = page.nextCursor ?? null;
        if (cursor === null) {
          break;
        }

        if (loaded.length >= MAXIMUM_CHILDREN) {
          partial = true;
          break;
        }

        response = await request(`${basePath}&cursor=${encodeURIComponent(cursor)}`, {
          signal: controller.signal,
        });
      }

      if (controller.signal.aborted) return;

      setChildren(loaded);
      setTruncated(partial);

      // The schema and the views are optional context. A workspace root has neither, and an item
      // whose schema request failed can still show its children - so these degrade rather than
      // failing the screen.
      storeSchema(await readOptional(schemaResponse, EffectiveSchemaSchema));
      storeViews(await readOptional(viewsResponse, ContainerViewsSchema));

      setStatus('ready');
    } catch {
      if (controller.signal.aborted) return;
      setError('Core could not be reached.');
      setStatus('error');
    } finally {
      if (activeLoad.current === controller) activeLoad.current = null;
    }
  }, [containerId, request]);

  useEffect(() => {
    let disposed = false;
    queueMicrotask(() => {
      if (!disposed) void load();
    });
    return () => {
      disposed = true;
      activeLoad.current?.abort();
    };
  }, [load]);

  const setProperties = useCallback(
    async (itemId: string, properties: Record<string, unknown>): Promise<string | null> => {
      setWriteError(null);

      // Optimistic: the card moves under the pointer and the request follows. A drag that waited
      // for a round trip before moving would feel broken, and the reconcile below puts it back if
      // the server disagrees.
      //
      // The one item is captured, not the whole array: concurrent writes fired in one tick share
      // this closure, and reverting the array a write happened to see would wipe the optimistic
      // values of every other write in flight - including rows the server had already stored.
      const before = children.find((item) => item.id === itemId);
      setChildren((current) =>
        current.map((item) =>
          item.id === itemId
            ? { ...item, properties: { ...item.properties, ...properties } }
            : item,
        ),
      );

      const putBack = (): void => {
        // Put it back exactly where it was and say why. Leaving the card in its new column after
        // the server refused would be a lie that survives until the next reload.
        if (before !== undefined) {
          setChildren((current) => current.map((item) => (item.id === itemId ? before : item)));
        }
      };

      let response: Response;
      try {
        response = await request(`/api/v1/items/${itemId}/properties`, {
          method: 'PATCH',
          body: JSON.stringify({ properties }),
        });
      } catch {
        // The request never reached the server - offline, DNS, a dropped connection. Without this
        // the promise rejected, nothing rolled back, and the cell kept showing a value the server
        // never took, with no sentence anywhere saying so.
        putBack();
        const failure = 'That change could not be sent. Check the connection and try again.';
        setWriteError(failure);
        return failure;
      }

      if (!response.ok) {
        const problem = (await response.json().catch(() => null)) as { detail?: string } | null;
        const refusal = problem?.detail ?? 'That change could not be saved.';

        putBack();

        // Said twice, to two different kinds of caller - see the two channels on `setProperties`.
        // Setting both is safe because no view reads both: the one that awaits the answer renders
        // it where the edit happened, and stops reading `writeError` for exactly that reason.
        setWriteError(refusal);
        return refusal;
      }

      const updated = ItemSchema.safeParse(await response.json());
      if (updated.success) {
        // A write answers with the item, never with a fresh fold of its children, so the rollups
        // it carries are null - and replacing the row with that would blank every rollup column on
        // it. `keepComputed` holds the last folded values rather than reporting none.
        setChildren((current) =>
          current.map((item) =>
            item.id === itemId ? keepComputed(item, updated.data) : item,
          ),
        );
      }

      return null;
    },
    [children, request],
  );

  const setPropertiesMany = useCallback(
    async (writes: readonly PlanWrite[]): Promise<PlanOutcome> => {
      if (writes.length === 0) {
        return { saved: 0, refused: [] };
      }

      if (writes.length > MAXIMUM_PLAN_WRITES) {
        return {
          saved: 0,
          refused: [
            {
              label: 'The whole gesture',
              reason: `this would change ${String(writes.length)} rows at once, and the most one gesture takes is ${String(MAXIMUM_PLAN_WRITES)}.`,
            },
          ],
        };
      }

      // One optimistic pass for the whole plan, not one per row: N chained map passes are N
      // renders and N walks, and the plan is one gesture that should paint once.
      const beforeById = new Map(children.map((item) => [item.id, item]));
      const bags = new Map(writes.map((write) => [write.itemId, write.properties]));
      setChildren((current) =>
        current.map((item) => {
          const bag = bags.get(item.id);
          return bag === undefined ? item : { ...item, properties: { ...item.properties, ...bag } };
        }),
      );

      // Bounded concurrency rather than a request storm: a 1,000-row paste at full parallelism is
      // 1,000 sockets fighting the browser's own per-host cap, and there is no cancelling it.
      const results = new Array<{ write: PlanWrite; refusal: string | null; stored: Item | null }>(
        writes.length,
      );
      let next = 0;

      async function worker(): Promise<void> {
        for (;;) {
          const index = next;
          next += 1;
          const write = writes[index];
          if (write === undefined) {
            return;
          }

          try {
            const response = await request(`/api/v1/items/${write.itemId}/properties`, {
              method: 'PATCH',
              body: JSON.stringify({ properties: write.properties }),
            });

            if (!response.ok) {
              const problem = (await response.json().catch(() => null)) as {
                detail?: string;
              } | null;
              results[index] = {
                write,
                refusal: problem?.detail ?? 'That change could not be saved.',
                stored: null,
              };
              continue;
            }

            const updated = ItemSchema.safeParse(await response.json());
            results[index] = {
              write,
              refusal: null,
              stored: updated.success ? updated.data : null,
            };
          } catch {
            results[index] = {
              write,
              refusal: 'that change could not be sent. Check the connection and try again.',
              stored: null,
            };
          }
        }
      }

      await Promise.all(
        Array.from({ length: Math.min(PLAN_CONCURRENCY, writes.length) }, () => worker()),
      );

      // One reconciling pass: rows the server stored take its answer, rows it refused go back
      // exactly as they were, rows it never mentioned keep their optimistic value. This is what
      // the per-row path cannot do - its rollback knows one row and one snapshot.
      const storedById = new Map<string, Item>();
      const revertIds = new Set<string>();
      const refused: PlanRefusal[] = [];

      for (const result of results) {
        if (result.refusal !== null) {
          refused.push({ label: result.write.label, reason: result.refusal });
          revertIds.add(result.write.itemId);
        } else if (result.stored !== null) {
          storedById.set(result.stored.id, result.stored);
        }
      }

      setChildren((current) =>
        current.map((item) => {
          const stored = storedById.get(item.id);
          if (stored !== undefined) {
            return stored;
          }
          if (revertIds.has(item.id)) {
            return beforeById.get(item.id) ?? item;
          }
          return item;
        }),
      );

      return { saved: writes.length - refused.length, refused };
    },
    [children, request],
  );

  /**
   * Sends a replacement schema or view set, and reloads on success.
   *
   * Not optimistic, unlike a property write. A property write is a drag that has to keep up with a
   * pointer; these are a form somebody submits and waits on, and the answer they need is whether
   * it was accepted - which for a schema is frequently "no, and here is why".
   */
  const replace = useCallback(
    async (path: string, body: unknown): Promise<string | null> => {
      const response = await request(path, { method: 'PUT', body: JSON.stringify(body) });

      if (!response.ok) {
        const problem = (await response.json().catch(() => null)) as { detail?: string } | null;
        return problem?.detail ?? 'That could not be saved.';
      }

      await load();
      return null;
    },
    [load, request],
  );

  const setSchema = useCallback(
    async (draft: SchemaDraft): Promise<string | null> => {
      if (containerId === null) {
        return 'A workspace root cannot declare a schema.';
      }

      return await replace(`/api/v1/items/${containerId}/schema`, {
        inherit: draft.inherit,
        properties: draft.properties.map((property) => ({
          key: property.key,
          label: property.label,
          type: property.type,

          // Only the select types carry options, and the server refuses a schema where anything
          // else does. Sending an empty array for the rest would be refused on a technicality
          // nobody typed.
          options: property.options.length > 0 ? property.options : null,
          required: property.required,

          // Only a formula carries one, and the server refuses a schema where anything else does -
          // the same technicality the options line above avoids, for the same reason.
          expression: property.type === 'formula' ? (property.expression ?? null) : null,

          // The same rule for the rollup's pair. A count of the children carries no source, and
          // sending one would be refused for naming a property the fold ignores.
          aggregate: property.type === 'rollup' ? (property.aggregate ?? null) : null,
          source: property.type === 'rollup' ? (property.source ?? null) : null,
        })),
      });
    },
    [containerId, replace],
  );

  const setViews = useCallback(
    async (next: readonly View[], defaultView?: string | null): Promise<string | null> => {
      if (containerId === null) {
        return 'A workspace root cannot offer views.';
      }

      // The default is sent as it stands unless the caller says otherwise. Omitting it on an edit
      // that was not about the default would reset it to the document, so somebody renaming a view
      // would find the item opening somewhere else afterwards.
      return await replace(`/api/v1/items/${containerId}/views`, {
        views: next,
        default: defaultView === undefined ? (views?.default ?? null) : defaultView,
      });
    },
    [containerId, replace, views],
  );

  const appendViewSetup = useCallback(
    async (
      properties: readonly PropertyDefinition[],
      addedViews: readonly View[],
      makeDefault: boolean,
      publishInteractiveFormViewId: string | null = null,
    ): Promise<string | null> => {
      if (containerId === null) return 'A workspace root cannot offer views.';
      try {
        const response = await request(`/api/v1/items/${containerId}/view-setups`, {
          method: 'POST',
          body: JSON.stringify({
            properties: properties.map((property) => ({
              ...property,
              options: property.options.length === 0 ? null : property.options,
            })),
            views: addedViews,
            makeDefault,
            publishInteractiveFormViewId,
          }),
        });
        if (!response.ok) {
          const problem = (await response.json().catch(() => null)) as { detail?: string } | null;
          return problem?.detail ?? 'This view setup could not be saved.';
        }
        await load();
        return null;
      } catch {
        return 'This view setup could not be sent. Check the connection and try again.';
      }
    },
    [containerId, load, request],
  );

  const replaceViewSetup = useCallback(
    async (
      originalViewId: string,
      properties: readonly PropertyDefinition[],
      replacementViews: readonly View[],
      publishInteractiveFormViewId: string | null = null,
    ): Promise<string | null> => {
      if (containerId === null) return 'A workspace root cannot offer views.';
      try {
        const response = await request(
          `/api/v1/items/${containerId}/view-setups/${encodeURIComponent(originalViewId)}`,
          {
            method: 'PUT',
            body: JSON.stringify({
              schema: {
                inherit: schema?.inherit ?? true,
                properties: properties.map((property) => ({
                  ...property,
                  options: property.options.length === 0 ? null : property.options,
                })),
              },
              originalPropertyKeys: schema?.declared.map((property) => property.key) ?? [],
              views: replacementViews,
              publishInteractiveFormViewId,
            }),
          },
        );
        if (!response.ok) {
          const problem = (await response.json().catch(() => null)) as { detail?: string } | null;
          return problem?.detail ?? 'This view setup could not be saved.';
        }
        await load();
        return null;
      } catch {
        return 'This view setup could not be sent. Check the connection and try again.';
      }
    },
    [containerId, load, request, schema?.declared, schema?.inherit],
  );

  /**
   * Remembers which view opens.
   *
   * **Called from a deliberate switch and from nowhere else.** Arriving at a URL that already
   * carries `?view=` must not write anything: a shared link would otherwise rewrite the default for
   * everybody in the workspace, silently, for the person who followed it. That rule is kept by
   * where this is called rather than by a check inside it - there is no effect watching the URL,
   * so there is nothing to get wrong.
   */
  const setDefaultView = useCallback(
    async (viewId: string): Promise<string | null> => {
      if (containerId === null || views === null) {
        return null;
      }

      if (views.default === viewId) {
        return null;
      }

      const previous = views;
      const write = defaultViewWrite.current + 1;
      defaultViewWrite.current = write;

      // Switching views must not reload every child just to remember one identifier. Large
      // containers take several pages to load, and coupling this preference write to `load()`
      // made each switch discard the data already on screen and start that walk again. Optimistic
      // local state also makes a second quick switch compare against the choice the person just
      // made rather than a stale server response.
      storeViews({ ...views, default: viewId });

      try {
        const response = await request(`/api/v1/items/${containerId}/views`, {
          method: 'PUT',
          body: JSON.stringify({ views: views.views, default: viewId }),
        });
        if (!response.ok) {
          const problem = (await response.json().catch(() => null)) as {
            detail?: string;
          } | null;
          if (defaultViewWrite.current === write) {
            storeViews(previous);
          }
          return problem?.detail ?? 'That view could not be remembered.';
        }

        const parsed = ContainerViewsSchema.safeParse(await response.json());
        if (!parsed.success) {
          console.warn('The saved views did not match the contract:', parsed.error.message);
          return 'The view was saved, but Core returned an unreadable response.';
        }
        if (defaultViewWrite.current === write) {
          storeViews(parsed.data);
        }
        return null;
      } catch {
        if (defaultViewWrite.current === write) {
          storeViews(previous);
        }
        return 'That view could not be remembered. Check the connection and try again.';
      }
    },
    [containerId, request, views],
  );

  const create = useCallback(
    async (title: string, properties?: Record<string, unknown>): Promise<string | null> => {
      if (createChild === undefined) {
        return 'This container cannot hold items.';
      }

      const refusal = await createChild(title, properties);

      // Reloaded here rather than by the caller, because this hook owns the children a view is
      // drawing and the tree's own store is a different list. Skipped on a refusal: nothing
      // changed, and a reload would only make the screen flicker to say so.
      if (refusal === null) {
        await load();
      }

      return refusal;
    },
    [createChild, load],
  );

  /**
   * The children as every view reads them: what the server sent, plus the properties this build
   * computes rather than stores.
   *
   * Derived on the way out rather than merged into state, so the optimistic write paths above keep
   * operating on exactly what the server sent and a computed value can never be mistaken for one
   * to send back. `decorateItems` returns the same array when the schema declares no formulas, so
   * a container without any pays nothing at all.
   *
   * Memoised for identity, not for arithmetic: `children` is the dependency of every view's own
   * memoised sort, filter and virtual window, and a fresh array each render would re-run all of
   * them on every keystroke elsewhere on the screen.
   */
  const computedChildren = useMemo(
    () => decorateItems(children, schema?.properties),
    [children, schema?.properties],
  );

  return {
    itemId: containerId,
    status,
    error,
    create,
    schema,
    views,
    children: computedChildren,
    setProperties,
    setPropertiesMany,
    setSchema,
    setDefaultView,
    setViews,
    appendViewSetup,
    replaceViewSetup,
    writeError,
    truncated,
    reload: load,
  };
}

/**
 * Reads a response that the screen can do without.
 *
 * The schema and the views are context rather than content: a workspace root has neither, and a
 * item whose schema request failed can still show its children. So these degrade to null rather
 * than failing the screen - which is the opposite of how the children are treated, and deliberately
 * so. An item with no schema is ordinary; an item whose contents would not parse is not.
 */
async function readOptional<TValue>(
  response: Response | null,
  schema: ZodType<TValue>,
): Promise<TValue | null> {
  if (!response?.ok) {
    return null;
  }

  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) {
    console.warn('A container response did not match the contract:', parsed.error.message);
    return null;
  }

  return parsed.data;
}
