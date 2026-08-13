import { workspaceCalendarSchema, type WorkspaceCalendar } from '@nix/api-client';
import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '../auth/auth-provider';

/**
 * Every calendar in one workspace, collated into one window.
 *
 * Talks to Core with `fetch` rather than through `@nix/api-client`'s cache layer, for the reason
 * `use-workspace-graph.ts` gives: the descriptor executor wants a configured `NixClient` and this
 * needs one thing, a bearer token per request. Both hooks change together when that is wired, and
 * the schema below is the same one the client resource would have used, so the parse is not
 * duplicated logic - only the transport is.
 *
 * **Parsed, not cast.** A calendar built from an unvalidated payload fails as a picture rather than
 * as an error: a missing `dateProperty` becomes an entry quietly placed nowhere, and nobody finds
 * out. Zod turns that into a state this hook can report.
 *
 * **The window is an argument, so moving through time refetches.** The server bounds what it will
 * answer, and asking for a year to avoid a second request would be asking for far more than a month
 * grid can draw.
 */

/** The workspace the shell is scoped to, read exactly as `use-workspace-tree.ts` reads it. */
function readWorkspaceId(): string {
  const configured: unknown = import.meta.env.VITE_WORKSPACE_ID;
  return typeof configured === 'string' && configured.length > 0
    ? configured
    : 'a1000000-0000-4000-8000-000000000001';
}

const WORKSPACE_ID = readWorkspaceId();

/**
 * Why a failed read failed, in words a reader can act on.
 *
 * **Keyed on the problem's `code`, not on the status alone**, for the reason
 * `use-workspace-graph.ts` records at length: a 404 carrying a code is the refusal it claims to be,
 * and a bodyless 404 is this build asking a server that does not offer the endpoint. Conflating
 * them once already sent a debugging session after a permission bug that did not exist.
 */
async function refusal(response: Response): Promise<string> {
  const code: unknown = await response
    .json()
    .then((body: unknown) =>
      typeof body === 'object' && body !== null && 'code' in body ? body.code : null,
    )
    // A body that is absent or is not JSON at all - which is exactly what a routing 404 sends.
    .catch(() => null);

  if (code === 'workspaces.not_found') {
    return 'This workspace could not be found.';
  }

  if (code === 'calendar.invalid_window') {
    // Not a reader's mistake - they picked a month from a control. If this is ever on screen it is
    // this build sending a window the server will not take, which is a bug rather than a refusal.
    return 'This version of the application asked for a range the server refused.';
  }

  if (response.status === 404) {
    return 'This version of the application asked for a calendar the server does not offer. The server may be running an older build.';
  }

  return 'The calendar could not be loaded.';
}

export type CalendarStatus = 'loading' | 'ready' | 'error';

export interface WorkspaceCalendarState {
  readonly status: CalendarStatus;

  /** The payload, or null while loading and after a failure. Never a half-built stand-in. */
  readonly calendar: WorkspaceCalendar | null;
  readonly error: string | null;
  readonly reload: () => Promise<void>;
}

/**
 * @param from The first day to read, `yyyy-MM-dd`, inclusive.
 * @param to The last day to read, `yyyy-MM-dd`, inclusive.
 */
export function useWorkspaceCalendar(from: string, to: string): WorkspaceCalendarState {
  const { getAccessToken } = useAuth();

  const [status, setStatus] = useState<CalendarStatus>('loading');
  const [calendar, setCalendar] = useState<WorkspaceCalendar | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setStatus('loading');
    setError(null);

    try {
      const token = await getAccessToken();
      const response = await fetch(
        `/api/v1/workspaces/${WORKSPACE_ID}/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        {
          headers: {
            'content-type': 'application/json',
            ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          },
        },
      );

      if (!response.ok) {
        setStatus('error');
        setError(await refusal(response));
        return;
      }

      const parsed = workspaceCalendarSchema.safeParse(await response.json());
      if (!parsed.success) {
        setStatus('error');
        setError('The calendar came back in a shape this version does not understand.');
        return;
      }

      setCalendar(parsed.data);
      setStatus('ready');
    } catch {
      // A dropped connection, an aborted request, or a body that is not JSON at all. None of them
      // tells the reader anything they can act on beyond "try again", which the panel offers.
      setStatus('error');
      setError('The calendar could not be loaded.');
    }
  }, [getAccessToken, from, to]);

  // Deferred a microtask, the same way `use-current-principal.ts` defers its own first read.
  // `load` sets state on its first line, and doing that synchronously inside an effect body is the
  // cascading-render pattern `react-hooks/set-state-in-effect` exists to stop.
  useEffect(() => {
    queueMicrotask(() => {
      void load();
    });
  }, [load]);

  return { status, calendar, error, reload: load };
}
