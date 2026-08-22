import { workspaceCalendarSchema, type WorkspaceCalendar } from '@nix/api-client';
import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '../auth/auth-provider';
import { ContainerViewsSchema } from '../views/core/container-model';

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

  /**
   * Writes an entry's own date property, then re-reads.
   *
   * Takes the property key rather than looking it up, because the caller is holding the entry and
   * this hook is not - and the key is the whole reason a collated calendar can write at all.
   *
   * Answers whether it stuck. A refusal is the caller's to undo: this hook does not hold the
   * optimistic copy and cannot put it back.
   */
  readonly reschedule: (itemId: string, dateProperty: string, value: string) => Promise<boolean>;

  /**
   * Makes a new item in a chosen container, dated on that container's own calendar property.
   *
   * **The property is resolved here, from the container's own view configuration - never from a
   * calendar entry.** An entry's `dateProperty` only exists for a container that has already
   * placed something in the window on screen, which is exactly the condition a container being
   * created into for the first time does not meet, and the whole reason goal 3.10 exists: a page
   * must be able to tell what a note places by without needing an entry to already be visible. So
   * this reads the container's own `views` afresh, takes the first calendar-kind view exactly as
   * `CalendarSql`'s `rank = 1` does, and writes that view's property - a value the window on screen
   * cannot change no matter which month it happens to be showing.
   *
   * Two requests, because that is what already exists: create the item bare, then the same
   * property write `reschedule` makes. A refusal names which of the two failed, in the server's own
   * words, and an item created but left undated is said plainly rather than hidden - it will not
   * appear on this calendar, since nothing here draws an item with no date.
   *
   * Answers the reason it was refused, or null when both writes stuck.
   */
  readonly create: (containerId: string, title: string, day: string) => Promise<string | null>;
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

  const reschedule = useCallback(
    async (itemId: string, dateProperty: string, value: string): Promise<boolean> => {
      try {
        const token = await getAccessToken();
        const response = await fetch(`/api/v1/items/${itemId}/properties`, {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          },
          // Only the one property. A PATCH carrying the whole bag would overwrite whatever another
          // reader changed between this view's last read and this drop.
          body: JSON.stringify({ properties: { [dateProperty]: value } }),
        });

        if (!response.ok) {
          return false;
        }

        // Re-read rather than patching the entry in place. The window may now hold a different set
        // - a drag can move something out of the month on screen - and only the server knows.
        await load();
        return true;
      } catch {
        return false;
      }
    },
    [getAccessToken, load],
  );

  const create = useCallback(
    async (containerId: string, title: string, day: string): Promise<string | null> => {
      const token = await getAccessToken();
      const authHeader = token === null ? {} : { authorization: `Bearer ${token}` };

      let dateProperty: string;
      try {
        const viewsResponse = await fetch(`/api/v1/items/${containerId}/views`, {
          headers: { 'content-type': 'application/json', ...authHeader },
        });

        if (!viewsResponse.ok) {
          return "This note's calendar configuration could not be read.";
        }

        const parsed = ContainerViewsSchema.safeParse(await viewsResponse.json());
        if (!parsed.success) {
          return "This note's calendar came back in a shape this version does not understand.";
        }

        // The first calendar-kind view, in view order - the same view `CalendarSql`'s
        // `rank = 1` picks server-side, so this build and Core agree on which property a
        // container with several calendar views actually places by.
        const resolved =
          parsed.data.views.find((view) => view.kind === 'calendar')?.dateProperty ?? null;
        if (resolved === null) {
          return "This note's calendar no longer names a date property, so nothing can be placed there.";
        }

        dateProperty = resolved;
      } catch {
        return "This note's calendar configuration could not be read.";
      }

      try {
        const createResponse = await fetch(`/api/v1/workspaces/${WORKSPACE_ID}/items`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeader },
          body: JSON.stringify({ type: 'note', title, parentId: containerId, properties: null }),
        });

        if (!createResponse.ok) {
          const problem = (await createResponse.json().catch(() => null)) as {
            detail?: string;
          } | null;
          return (
            problem?.detail ?? `The item could not be created (${String(createResponse.status)}).`
          );
        }

        const createdBody: unknown = await createResponse.json();
        const createdId =
          typeof createdBody === 'object' && createdBody !== null && 'id' in createdBody
            ? createdBody.id
            : null;

        if (typeof createdId !== 'string') {
          return 'The item was created, but the response could not be understood.';
        }

        const propertiesResponse = await fetch(`/api/v1/items/${createdId}/properties`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', ...authHeader },
          body: JSON.stringify({ properties: { [dateProperty]: day } }),
        });

        if (!propertiesResponse.ok) {
          const problem = (await propertiesResponse.json().catch(() => null)) as {
            detail?: string;
          } | null;
          const reason =
            problem?.detail ??
            `The date could not be saved (${String(propertiesResponse.status)}).`;
          // The item exists but carries no date, so it will not appear on this calendar - there is
          // no phantom entry, only an orphan the reader now knows to go find.
          return `"${title}" was created, but its date could not be set: ${reason}`;
        }

        // Re-read rather than inserting the new entry in place, matching `reschedule`: the window
        // may now hold a different set, and only the server knows.
        await load();
        return null;
      } catch {
        return 'The entry could not be created.';
      }
    },
    [getAccessToken, load],
  );

  // Deferred a microtask, the same way `use-current-principal.ts` defers its own first read.
  // `load` sets state on its first line, and doing that synchronously inside an effect body is the
  // cascading-render pattern `react-hooks/set-state-in-effect` exists to stop.
  useEffect(() => {
    queueMicrotask(() => {
      void load();
    });
  }, [load]);

  return { status, calendar, error, reload: load, reschedule, create };
}
