import { useCallback, useEffect, useState } from 'react';
import type { ZodType } from 'zod';

import { useAuth } from '../auth/auth-provider';
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
 * empty folder - which is exactly the distinction a view has to draw, since an empty board and a
 * broken board look identical if you let them.
 */

export type ContainerStatus = 'loading' | 'ready' | 'error';

export interface ContainerData {
  readonly status: ContainerStatus;
  readonly error: string | null;
  readonly schema: EffectiveSchema | null;
  readonly views: ContainerViews | null;
  readonly children: readonly Item[];

  /** Writes property values onto one child and refreshes it in place. */
  readonly setProperties: (itemId: string, properties: Record<string, unknown>) => Promise<void>;

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

  /**
   * Remembers which view opens, when somebody deliberately switches to it.
   *
   * Never called for a URL that merely arrived carrying `?view=`. See the implementation for why
   * that distinction is the whole of this feature's risk.
   */
  readonly setDefaultView: (viewId: string) => Promise<string | null>;

  /** The last property write that failed, for a view to report without losing the item. */
  readonly writeError: string | null;

  readonly reload: () => Promise<void>;
}

function readWorkspaceId(): string {
  const configured: unknown = import.meta.env.VITE_WORKSPACE_ID;
  return typeof configured === 'string' && configured.length > 0
    ? configured
    : 'a1000000-0000-4000-8000-000000000001';
}

const WORKSPACE_ID = readWorkspaceId();

export function useContainer(containerId: string | null): ContainerData {
  const { getAccessToken } = useAuth();

  const [status, setStatus] = useState<ContainerStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [schema, storeSchema] = useState<EffectiveSchema | null>(null);
  const [views, storeViews] = useState<ContainerViews | null>(null);
  const [children, setChildren] = useState<readonly Item[]>([]);

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
      const childrenPath =
        containerId === null
          ? `/api/v1/workspaces/${WORKSPACE_ID}/items`
          : `/api/v1/workspaces/${WORKSPACE_ID}/items?parentId=${containerId}`;

      // In parallel: three independent reads, and the screen needs all three before it can draw
      // anything. Sequencing them would make opening a folder three round trips deep.
      const [childrenResponse, schemaResponse, viewsResponse] = await Promise.all([
        request(childrenPath),
        containerId === null
          ? Promise.resolve(null)
          : request(`/api/v1/items/${containerId}/schema`),
        containerId === null
          ? Promise.resolve(null)
          : request(`/api/v1/items/${containerId}/views`),
      ]);

      if (!childrenResponse.ok) {
        const problem = (await childrenResponse.json().catch(() => null)) as {
          detail?: string;
        } | null;
        setError(
          problem?.detail ??
            `This folder could not be loaded (${String(childrenResponse.status)}).`,
        );
        setStatus('error');
        return;
      }

      const page = (await childrenResponse.json()) as { items: unknown[] };
      const parsed = page.items.map((item) => ItemSchema.safeParse(item));

      const bad = parsed.find((result) => !result.success);
      if (bad !== undefined) {
        // A parse failure is telemetry, not a silent fallback: it means the contract moved and
        // this build did not.
        console.warn('An item did not match the contract:', bad.error.message);
        setError('This folder could not be read.');
        setStatus('error');
        return;
      }

      setChildren(parsed.flatMap((result) => (result.success ? [result.data] : [])));

      // The schema and the views are optional context. A workspace root has neither, and a folder
      // whose schema request failed can still show its children - so these degrade rather than
      // failing the screen.
      storeSchema(await readOptional(schemaResponse, EffectiveSchemaSchema));
      storeViews(await readOptional(viewsResponse, ContainerViewsSchema));

      setStatus('ready');
    } catch {
      setError('Core could not be reached.');
      setStatus('error');
    }
  }, [containerId, request]);

  useEffect(() => {
    queueMicrotask(() => {
      void load();
    });
  }, [load]);

  const setProperties = useCallback(
    async (itemId: string, properties: Record<string, unknown>): Promise<void> => {
      setWriteError(null);

      // Optimistic: the card moves under the pointer and the request follows. A drag that waited
      // for a round trip before moving would feel broken, and the reconcile below puts it back if
      // the server disagrees.
      const previous = children;
      setChildren((current) =>
        current.map((item) =>
          item.id === itemId
            ? { ...item, properties: { ...item.properties, ...properties } }
            : item,
        ),
      );

      const response = await request(`/api/v1/items/${itemId}/properties`, {
        method: 'PATCH',
        body: JSON.stringify({ properties }),
      });

      if (!response.ok) {
        const problem = (await response.json().catch(() => null)) as { detail?: string } | null;

        // Put it back exactly where it was and say why. Leaving the card in its new column after
        // the server refused would be a lie that survives until the next reload.
        setChildren(previous);
        setWriteError(problem?.detail ?? 'That change could not be saved.');
        return;
      }

      const updated = ItemSchema.safeParse(await response.json());
      if (updated.success) {
        setChildren((current) => current.map((item) => (item.id === itemId ? updated.data : item)));
      }
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

      return await setViews(views.views, viewId);
    },
    [containerId, setViews, views],
  );

  return {
    status,
    error,
    schema,
    views,
    children,
    setProperties,
    setSchema,
    setDefaultView,
    setViews,
    writeError,
    reload: load,
  };
}

/**
 * Reads a response that the screen can do without.
 *
 * The schema and the views are context rather than content: a workspace root has neither, and a
 * folder whose schema request failed can still show its children. So these degrade to null rather
 * than failing the screen - which is the opposite of how the children are treated, and deliberately
 * so. A folder with no schema is ordinary; a folder whose contents would not parse is not.
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
