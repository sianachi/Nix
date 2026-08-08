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
 * **`items` is a seed, not live state.** It changes exactly once, when the mount-time read
 * resolves, and `save` deliberately does not mirror what it was handed back into it. Excalidraw
 * owns the live library; mirroring it here gave every save a state change, and a state change
 * re-armed the editor's seeding effect, whose `updateLibrary` echoed back through
 * `onLibraryChange` into another save - a feedback loop that hammered Core with identical PUTs
 * and hung the tab.
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
  /** What Core held at mount, for seeding Excalidraw. Empty while loading or on a failed read. */
  readonly items: readonly unknown[];
  /** Replaces the library wholesale with what Excalidraw's own `onLibraryChange` reports. */
  readonly save: (items: readonly unknown[]) => void;
}

const NONE: readonly unknown[] = [];

export function useCanvasLibrary(): CanvasLibraryState {
  const { getAccessToken } = useAuth();
  const [status, setStatus] = useState<CanvasLibraryStatus>('loading');
  const [items, setItems] = useState<readonly unknown[]>(NONE);

  // Guards saves until the mount-time read lands: Excalidraw fires `onLibraryChange` with
  // whatever it booted with, and saving that before the fetch resolves would overwrite a library
  // that has not been read yet with an empty one. Stays false forever when the read fails, which
  // makes saving impossible for the mount - overwriting state we could not read is worse than
  // dropping one session's additions.
  const loadedRef = useRef(false);

  // The request body Core is known to hold, or null when that is unknown (before the read, or
  // after a failed save). A save whose body matches is dropped without a request - which is what
  // breaks the echo: `updateLibrary` re-announces the seeded library through `onLibraryChange`,
  // and without this comparison that announcement was a PUT of content Core already had, forever.
  const knownRef = useRef<string | null>(null);

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
        knownRef.current = JSON.stringify({ items: parsed.items });
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
      if (!loadedRef.current) {
        return;
      }

      const body = JSON.stringify({ items: nextItems });
      if (body === knownRef.current) {
        return;
      }

      // Claimed before the request rather than after it, so the echoes that arrive while the PUT
      // is in flight are deduplicated too; the failure path below un-claims it.
      knownRef.current = body;

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
            body,
          });

          if (!response.ok) {
            throw new Error(`The canvas library could not be saved (${String(response.status)}).`);
          }
        } catch (cause) {
          // Core does not hold what we claimed it does, so forget the claim: the next change
          // retries instead of being deduplicated against a write that never landed.
          knownRef.current = null;
          console.warn('The canvas library save failed.', cause);
        }
      })();
    },
    [getAccessToken],
  );

  return { status, items, save };
}
