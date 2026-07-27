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
} from './container-model';

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
  const [schema, setSchema] = useState<EffectiveSchema | null>(null);
  const [views, setViews] = useState<ContainerViews | null>(null);
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
        containerId === null ? Promise.resolve(null) : request(`/api/v1/items/${containerId}/schema`),
        containerId === null ? Promise.resolve(null) : request(`/api/v1/items/${containerId}/views`),
      ]);

      if (!childrenResponse.ok) {
        const problem = (await childrenResponse.json().catch(() => null)) as { detail?: string } | null;
        setError(problem?.detail ?? `This folder could not be loaded (${String(childrenResponse.status)}).`);
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
      setSchema(await readOptional(schemaResponse, EffectiveSchemaSchema));
      setViews(await readOptional(viewsResponse, ContainerViewsSchema));

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
        setChildren((current) =>
          current.map((item) => (item.id === itemId ? updated.data : item)),
        );
      }
    },
    [children, request],
  );

  return {
    status,
    error,
    schema,
    views,
    children,
    setProperties,
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
