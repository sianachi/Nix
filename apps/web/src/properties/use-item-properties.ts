import {
  isCanceledError,
  isNixApiError,
  items as coreItems,
  structure as coreStructure,
} from '@nix/api-client';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useApiClient } from '../api/api-client-provider';
import { decorateItem, keepComputed } from './computed';
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
  const client = useApiClient();

  const [loading, setLoading] = useState(true);
  const [schema, setSchema] = useState<EffectiveSchema | null>(null);
  const [item, setItem] = useState<Item | null>(null);

  useEffect(() => {
    // A box rather than a bare flag: the cleanup writes it and the async body reads it, and a
    // narrowed boolean would let the compiler decide the second check is dead when it is the one
    // that matters.
    const live = { current: true };
    const controller = new AbortController();

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
        const [nextSchema, nextItem] = await Promise.all([
          queryOrNull(
            client.query(coreStructure.effectiveSchema(itemId), { signal: controller.signal }),
          ),
          queryOrNull(client.query(coreItems.itemById(itemId), { signal: controller.signal })),
        ]);

        // Dropped if the item changed while this was in flight. Without the guard, opening two
        // notes quickly could paint the first one's schema over the second's - a panel offering
        // properties that do not apply to what is on screen.
        if (!live.current || controller.signal.aborted) {
          return;
        }

        setSchema(nextSchema === null ? null : EffectiveSchemaSchema.parse(nextSchema));
        setItem(nextItem === null ? null : ItemSchema.parse(nextItem));
        setLoading(false);
      })().catch((reason: unknown) => {
        if (!controller.signal.aborted && live.current && !isCanceledError(reason)) {
          setSchema(null);
          setItem(null);
          setLoading(false);
        }
      });
    });

    return () => {
      live.current = false;
      controller.abort();
    };
  }, [client, itemId]);

  const write = useCallback(
    async (changes: Record<string, unknown>): Promise<string | null> => {
      if (itemId === null) {
        return 'There is nothing open to write to.';
      }

      try {
        // The response carries the item as it now stands, so the panel reflects what was stored
        // rather than what was typed - which is the difference that shows when the server normalised
        // something on the way in.
        const written = ItemSchema.parse(
          await client.execute(coreStructure.setItemProperties(itemId, changes)),
        );
        // The write answers with the item and not with a fresh fold of its children, so the
        // rollups come back null; keeping the last folded values is more honest than blanking the
        // panel's rollup rows on every edit.
        setItem((previous) => keepComputed(previous ?? undefined, written));
      } catch (reason) {
        return isNixApiError(reason) ? (reason.detail ?? 'That change could not be saved.') : 'That change could not be saved.';
      }

      return null;
    },
    [client, itemId],
  );

  /**
   * The item as the panel reads it: what the server sent, plus the properties this build computes.
   *
   * Derived rather than merged into state, so `write` keeps sending only the keys somebody edited
   * and a computed value can never be posted back as a stored one. Memoised for identity: the
   * panel's controls take this object as a prop, and `useDraft` compares the value it reads off it
   * against what it last sent - a fresh object each render is a fresh prop, which is the identity
   * that comparison hangs on.
   */
  const computed = useMemo(
    () => (item === null ? null : decorateItem(item, schema?.properties)),
    [item, schema?.properties],
  );

  return { loading, schema, item: computed, write };
}

/** Reads a response the panel can do without, reporting a refusal as an absent value. */
async function queryOrNull<TValue>(request: Promise<TValue>): Promise<TValue | null> {
  try {
    return await request;
  } catch (reason) {
    if (isCanceledError(reason)) {
      throw reason;
    }
    return null;
  }
}
