import type { CanvasLibraryContract } from '@nix/api-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';

import { useAuth } from '../auth/auth-provider';

/**
 * A principal's own set of reusable Excalidraw shapes, from `GET`/`PUT /api/v1/me/canvas-library`.
 *
 * **Per user, not per item or per workspace.** Excalidraw's own libraries feature is a personal
 * drawing tool - the shapes somebody has curated follow them into every canvas they open, the same
 * way a physical stencil is not left behind in one notebook. That is why this hook takes no
 * `itemId`: it asks Core for the caller's own library, the same request wherever a canvas mounts.
 *
 * Talks to Core directly with `fetch` rather than through `@nix/api-client`'s cache layer, matching
 * `use-current-principal.ts` and `use-backlinks.ts`: the client's descriptor execution wants a
 * configured `NixClient`, and this needs one thing, a bearer token on each request.
 */

const CanvasLibrarySchema = z.object({
  items: z.array(z.unknown()),
});

/**
 * The compile-time tie to the generated contract.
 *
 * Same idiom `use-current-principal.ts` uses: if Core renames or retypes a field on
 * `CanvasLibraryResponse`, this line stops compiling here rather than the canvas silently losing
 * saved shapes.
 */
const _canvasLibraryContract = CanvasLibrarySchema satisfies z.ZodType<CanvasLibraryContract>;
void _canvasLibraryContract;

export type CanvasLibraryStatus = 'loading' | 'ready' | 'error';

export interface CanvasLibraryState {
  readonly status: CanvasLibraryStatus;
  /** The library's items, empty while loading or on a failed read. */
  readonly items: readonly unknown[];
  /** Replaces the library wholesale with what Excalidraw's own `onLibraryChange` reports. */
  readonly save: (items: readonly unknown[]) => void;
}

const NONE: readonly unknown[] = [];

export function useCanvasLibrary(): CanvasLibraryState {
  const { getAccessToken } = useAuth();
  const [status, setStatus] = useState<CanvasLibraryStatus>('loading');
  const [items, setItems] = useState<readonly unknown[]>(NONE);

  // Guards the mount-time read against a save that lands first: without it, a save fired the
  // instant a canvas mounts (Excalidraw replays a saved library through `onLibraryChange` on
  // load) could be overwritten by the read's response arriving after.
  const loadedRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    const live = { current: true };

    void (async () => {
      try {
        const token = await getAccessToken();
        const response = await fetch('/api/v1/me/canvas-library', {
          signal: controller.signal,
          headers: {
            accept: 'application/json',
            ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          },
        });

        if (!response.ok) {
          throw new Error(`The canvas library could not be loaded (${String(response.status)}).`);
        }

        const parsed = CanvasLibrarySchema.parse(await response.json());
        if (!live.current) {
          return;
        }

        loadedRef.current = true;
        setItems(parsed.items);
        setStatus('ready');
      } catch (cause) {
        if (controller.signal.aborted || !live.current) {
          return;
        }

        console.warn('The canvas library read failed.', cause);
        setStatus('error');
      }
    })();

    return () => {
      live.current = false;
      controller.abort();
    };
  }, [getAccessToken]);

  const save = useCallback(
    (nextItems: readonly unknown[]) => {
      setItems(nextItems);

      // Excalidraw fires `onLibraryChange` once on mount with whatever it booted with, before this
      // hook's own read has necessarily returned. Saving that early would overwrite a library that
      // has not been fetched yet with an empty one.
      if (!loadedRef.current) {
        return;
      }

      void (async () => {
        try {
          const token = await getAccessToken();
          const response = await fetch('/api/v1/me/canvas-library', {
            method: 'PUT',
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
              ...(token === null ? {} : { authorization: `Bearer ${token}` }),
            },
            body: JSON.stringify({ items: nextItems }),
          });

          if (!response.ok) {
            throw new Error(`The canvas library could not be saved (${String(response.status)}).`);
          }
        } catch (cause) {
          console.warn('The canvas library save failed.', cause);
        }
      })();
    },
    [getAccessToken],
  );

  return { status, items, save };
}
