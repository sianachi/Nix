import {
  isCanceledError,
  isNixApiError,
  items as coreItems,
  structure as coreStructure,
  views as coreViews,
  workspaceCalendar as coreWorkspaceCalendar,
  type WorkspaceCalendar,
} from '@nix/api-client';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useApiClient } from '../api/api-client-provider';
import { useWorkspace } from '../workspaces/workspace-context';

export type CalendarStatus = 'loading' | 'ready' | 'error';

export interface WorkspaceCalendarState {
  readonly status: CalendarStatus;
  readonly calendar: WorkspaceCalendar | null;
  readonly error: string | null;
  readonly reload: () => Promise<void>;
  readonly reschedule: (itemId: string, dateProperty: string, value: string) => Promise<boolean>;
  readonly create: (containerId: string, title: string, day: string) => Promise<string | null>;
}

function calendarError(reason: unknown): string {
  if (isNixApiError(reason) && reason.code === 'workspaces.not_found') {
    return 'This workspace could not be found.';
  }
  if (isNixApiError(reason) && reason.code === 'calendar.invalid_window') {
    return 'This version of the application asked for a range the server refused.';
  }
  if (isNixApiError(reason) && reason.status === 404) {
    return 'This version of the application asked for a calendar the server does not offer. The server may be running an older build.';
  }
  return 'The calendar could not be loaded.';
}

function requestReason(reason: unknown, fallback: string): string {
  return isNixApiError(reason) ? (reason.detail ?? fallback) : fallback;
}

export function useWorkspaceCalendar(from: string, to: string): WorkspaceCalendarState {
  const client = useApiClient();
  const { workspaceId } = useWorkspace();
  const activeLoad = useRef<AbortController | null>(null);
  const operations = useRef(new Set<AbortController>());
  const [status, setStatus] = useState<CalendarStatus>('loading');
  const [calendar, setCalendar] = useState<WorkspaceCalendar | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    activeLoad.current?.abort();
    const controller = new AbortController();
    activeLoad.current = controller;
    setStatus('loading');
    setError(null);

    try {
      const next = await client.query(
        coreWorkspaceCalendar.workspaceCalendar(workspaceId, from, to),
        { signal: controller.signal, forceRefresh: true },
      );
      if (controller.signal.aborted || activeLoad.current !== controller) return;
      setCalendar(next);
      setStatus('ready');
    } catch (reason) {
      if (controller.signal.aborted || activeLoad.current !== controller || isCanceledError(reason))
        return;
      setCalendar(null);
      setError(calendarError(reason));
      setStatus('error');
    } finally {
      if (activeLoad.current === controller) activeLoad.current = null;
    }
  }, [client, from, to, workspaceId]);

  const reschedule = useCallback(
    async (itemId: string, dateProperty: string, value: string): Promise<boolean> => {
      const controller = new AbortController();
      operations.current.add(controller);
      try {
        await client.execute(coreStructure.setItemProperties(itemId, { [dateProperty]: value }), {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return false;
        await load();
        return true;
      } catch {
        return false;
      } finally {
        operations.current.delete(controller);
      }
    },
    [client, load],
  );

  const create = useCallback(
    async (containerId: string, title: string, day: string): Promise<string | null> => {
      const controller = new AbortController();
      operations.current.add(controller);
      try {
        const configuredViews = await client.query(
          coreViews.containerViewConfigurations(containerId),
          {
            signal: controller.signal,
            forceRefresh: true,
          },
        );
        const dateProperty =
          configuredViews.views.find((view) => view.kind === 'calendar')?.dateProperty ?? null;
        if (dateProperty === null) {
          return "This note's calendar no longer names a date property, so nothing can be placed there.";
        }

        await client.execute(
          coreItems.createItem(workspaceId, {
            type: 'note',
            title,
            parentId: containerId,
            properties: { [dateProperty]: day },
          }),
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return 'The entry could not be created.';
        await load();
        return null;
      } catch (reason) {
        if (isCanceledError(reason)) return 'The entry could not be created.';
        return requestReason(reason, 'The entry could not be created.');
      } finally {
        operations.current.delete(controller);
      }
    },
    [client, load, workspaceId],
  );

  useEffect(() => {
    let active = true;
    const pendingOperations = operations.current;
    queueMicrotask(() => {
      if (active) void load();
    });
    return () => {
      active = false;
      activeLoad.current?.abort();
      for (const controller of pendingOperations) controller.abort();
      pendingOperations.clear();
    };
  }, [load]);

  return { status, calendar, error, reload: load, reschedule, create };
}
