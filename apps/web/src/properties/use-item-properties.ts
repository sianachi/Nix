import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '../auth/auth-provider';
import {
  EffectiveSchemaSchema,
  ItemSchema,
  type EffectiveSchema,
  type Item,
} from '../views/core/container-model';

/**
 * One item's schema and the means to write its properties.
 *
 * Separate from `useContainer`, which loads a folder and everything in it. A note needs its own
 * effective schema and nothing else, and loading a folder's children to show one note's properties
 * would be a page of rows fetched to render a panel.
 *
 * **The schema is resolved at the item, not at its parent.** An item's own declaration is part of
 * what its values are checked against, and asking at the parent would miss it - the same
 * distinction the resolver draws between resolving for an item and resolving for its children.
 */

export interface ItemProperties {
  readonly loading: boolean;
  readonly schema: EffectiveSchema | null;

  /**
   * The item, with its property values.
   *
   * Fetched here rather than taken from the tree, which carries a narrower shape - it was built
   * before properties existed and knows nothing about them. Reaching into it for a value it does
   * not hold would be a cast that compiles and reads undefined.
   */
  readonly item: Item | null;

  /** Writes the changed properties, answering with the refusal reason or null. */
  readonly write: (changes: Record<string, unknown>) => Promise<string | null>;
}

export function useItemProperties(itemId: string | null): ItemProperties {
  const { getAccessToken } = useAuth();

  const [loading, setLoading] = useState(true);
  const [schema, setSchema] = useState<EffectiveSchema | null>(null);
  const [item, setItem] = useState<Item | null>(null);

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

  useEffect(() => {
    // A box rather than a bare flag: the cleanup writes it and the async body reads it, and a
    // narrowed boolean would let the compiler decide the second check is dead when it is the one
    // that matters.
    const live = { current: true };

    // queueMicrotask so the first setState lands after the effect returns rather than during it,
    // which is what stops the initial render cascading. The same reason the tree does it.
    queueMicrotask(() => {
      if (!live.current) {
        return;
      }

      if (itemId === null) {
        setSchema(null);
        setItem(null);
        setLoading(false);
        return;
      }

      setLoading(true);
      void (async () => {
        // Both at once: the panel cannot draw a field without knowing the property exists, and
        // cannot fill it without the value. Sequencing them would make opening a note two round
        // trips deep for one panel.
        const [schemaResponse, itemResponse] = await Promise.all([
          request(`/api/v1/items/${itemId}/schema`),
          request(`/api/v1/items/${itemId}`),
        ]);

        // Dropped if the item changed while this was in flight. Without the guard, opening two
        // notes quickly could paint the first one's schema over the second's - a panel offering
        // properties that do not apply to what is on screen.
        if (!live.current) {
          return;
        }

        setSchema(await readOrNull(schemaResponse, EffectiveSchemaSchema));
        setItem(await readOrNull(itemResponse, ItemSchema));
        setLoading(false);
      })();
    });

    return () => {
      live.current = false;
    };
  }, [itemId, request]);

  const write = useCallback(
    async (changes: Record<string, unknown>): Promise<string | null> => {
      if (itemId === null) {
        return 'There is nothing open to write to.';
      }

      const response = await request(`/api/v1/items/${itemId}/properties`, {
        method: 'PATCH',
        body: JSON.stringify({ properties: changes }),
      });

      if (!response.ok) {
        const problem = (await response.json().catch(() => null)) as { detail?: string } | null;
        return problem?.detail ?? 'That change could not be saved.';
      }

      // The response carries the item as it now stands, so the panel reflects what was stored
      // rather than what was typed - which is the difference that shows when the server normalised
      // something on the way in.
      const written = ItemSchema.safeParse(await response.json());
      if (written.success) {
        setItem(written.data);
      }

      return null;
    },
    [itemId, request],
  );

  return { loading, schema, item, write };
}

/** Reads a response the panel can do without, reporting a contract mismatch rather than hiding it. */
async function readOrNull<TValue>(
  response: Response,
  schema: {
    safeParse: (input: unknown) => { success: boolean; data?: TValue; error?: { message: string } };
  },
): Promise<TValue | null> {
  if (!response.ok) {
    return null;
  }

  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) {
    console.warn('A property response did not match the contract:', parsed.error?.message ?? '');
    return null;
  }

  return parsed.data ?? null;
}
