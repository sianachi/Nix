import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';

import { useAuth } from '../auth/auth-provider';

/**
 * What points at an item.
 *
 * Talks to Core directly with `fetch` rather than through `@nix/api-client`'s cache layer, for the
 * same reason `use-workspace-tree.ts` does: the client's descriptor execution wants a configured
 * `NixClient` and this needs one thing, a bearer token on each request. When the app-wide client is
 * wired, this hook changes with the others.
 *
 * **Every state the panel renders is represented separately**, because the panel renders them
 * separately. Loading is not empty, and a failed request is not an item nothing points at -
 * collapsing them is how somebody concludes their links are broken when the network hiccupped.
 */

const BacklinksSchema = z.object({
  backlinks: z.array(
    z.object({
      source: z.object({
        id: z.string(),
        workspaceId: z.string(),
        type: z.string(),
        title: z.string().nullable(),
      }),
      occurrences: z.number(),
    }),
  ),
  limit: z.number(),
  truncated: z.boolean(),
});

export type Backlink = z.infer<typeof BacklinksSchema>['backlinks'][number];

export type BacklinksStatus = 'loading' | 'ready' | 'error';

export interface Backlinks {
  readonly status: BacklinksStatus;
  readonly backlinks: readonly Backlink[];

  /**
   * Whether the server's ceiling was reached, so the panel can say "the first twenty-five" rather
   * than implying it has shown everything.
   */
  readonly truncated: boolean;

  /** Asks again, for the control a failed read offers. */
  readonly retry: () => void;
}

/** One completed read, tagged with the request it answers. */
interface BacklinksAnswer {
  readonly request: string;
  readonly backlinks: readonly Backlink[];
  readonly truncated: boolean;
  readonly failed: boolean;
}

/** One empty array, so "nothing points here" does not change identity on every render. */
const NONE: readonly Backlink[] = [];

export function useBacklinks(itemId: string | null): Backlinks {
  const { getAccessToken } = useAuth();
  const [answer, setAnswer] = useState<BacklinksAnswer | null>(null);
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => {
    setAttempt((previous) => previous + 1);
  }, []);

  // Which read the state below would have to be an answer to. Anything else is stale, which is
  // what makes "loading" a derived fact rather than a flag an effect has to set - and setting one
  // synchronously in an effect is a cascading render for something the render already knew.
  const request = `${itemId ?? ''}:${String(attempt)}`;
  const current = answer !== null && answer.request === request ? answer : null;

  useEffect(() => {
    if (itemId === null) {
      return;
    }

    const controller = new AbortController();

    // A box rather than a bare flag: narrowing would let the second read of a plain boolean be
    // elided, which is the bug `use-item-properties.ts` documents at length.
    const live = { current: true };

    void (async () => {
      try {
        const token = await getAccessToken();
        const response = await fetch(`/api/v1/items/${itemId}/backlinks`, {
          signal: controller.signal,
          headers: token === null ? {} : { authorization: `Bearer ${token}` },
        });

        if (!response.ok) {
          throw new Error(`Backlinks answered ${String(response.status)}.`);
        }

        const parsed = BacklinksSchema.parse(await response.json());
        if (!live.current) {
          return;
        }

        setAnswer({
          request,
          backlinks: parsed.backlinks,
          truncated: parsed.truncated,
          failed: false,
        });
      } catch (cause) {
        if (controller.signal.aborted || !live.current) {
          return;
        }

        console.warn('The backlinks read failed.', cause);
        setAnswer({ request, backlinks: NONE, truncated: false, failed: true });
      }
    })();

    return () => {
      live.current = false;
      controller.abort();
    };
  }, [getAccessToken, itemId, request]);

  return {
    status: current === null ? 'loading' : current.failed ? 'error' : 'ready',
    backlinks: current?.backlinks ?? NONE,
    truncated: current?.truncated ?? false,
    retry,
  };
}
