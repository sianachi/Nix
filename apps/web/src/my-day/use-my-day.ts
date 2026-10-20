import {
  habits as coreHabits,
  isCanceledError,
  isNixApiError,
  items as coreItems,
  myDay as coreMyDay,
  recurrence as coreRecurrence,
  structure as coreStructure,
  type HabitTracker,
  type MyDay,
  type MyDayHabitRow,
  type MyDayTaskRow,
  type SetHabitInput,
} from '@nix/api-client';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useApiClient } from '../api/api-client-provider';
import { onItemChildrenChanged } from '../lib/item-children-changed';
import { useWorkspace } from '../workspaces/workspace-context';

export type MyDayStatus = 'loading' | 'ready' | 'error';

export interface MyDayState {
  readonly status: MyDayStatus;
  readonly day: MyDay | null;

  /** Why the first load failed; the page is empty. */
  readonly error: string | null;

  /** Why the latest refresh failed while older content stays on screen; null when it is current. */
  readonly staleReason: string | null;
  readonly reload: () => Promise<void>;

  /** Finishes a task. Resolves to why it did not happen, or null when it did. */
  readonly completeTask: (row: MyDayTaskRow) => Promise<string | null>;

  /** Records today's progress for a habit, as an absolute value. */
  readonly checkIn: (
    row: MyDayHabitRow,
    input: { readonly completed: boolean; readonly quantity: number | null },
  ) => Promise<string | null>;
  readonly undoCheckIn: (row: MyDayHabitRow) => Promise<string | null>;

  /** The habit's saved settings for its edit form, or why they could not be read. */
  readonly readHabit: (row: MyDayHabitRow) => Promise<HabitTracker | string>;

  /** Saves the edit form: settings, then the title when it changed. Re-reads on success. */
  readonly saveHabit: (
    row: MyDayHabitRow,
    title: string,
    settings: SetHabitInput,
  ) => Promise<string | null>;
}

/** Row identity: the original item, plus the day for one occurrence of a repeating task. */
export const taskKey = (row: MyDayTaskRow): string =>
  `${row.itemId}:${row.action.occurredOn ?? ''}`;

const MAX_TIMER_MS = 2 ** 31 - 1;

function loadError(reason: unknown): string {
  if (isNixApiError(reason) && reason.status === 404) {
    return 'This workspace could not be found, or the server does not offer My Day. The server may be running an older build.';
  }
  if (isNixApiError(reason) && reason.code === 'query.too_many_in_flight') {
    return 'Too many reads are running for you at once. Wait a moment and try again.';
  }
  return 'My Day could not be loaded.';
}

function writeReason(reason: unknown, fallback: string): string {
  return isNixApiError(reason) ? (reason.detail ?? fallback) : fallback;
}

/** Whole milliseconds until the next midnight in `zone`, never less than a second. */
export function msUntilMidnight(zone: string, now: Date): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(now);
    const at = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
    const elapsed = ((at('hour') % 24) * 3600 + at('minute') * 60 + at('second')) * 1000;
    return Math.max(1000, 86_400_000 - elapsed);
  } catch {
    return 3_600_000;
  }
}

/**
 * Reads My Day for the open workspace and performs the writes its rows offer.
 *
 * Every write goes to the original item through the command that already owns it; nothing here
 * keeps a copy. After a write the whole projection is re-read, because a write does not invalidate
 * a key it does not own. Content from another workspace is cleared the moment the scope changes,
 * and a refusal that means "you may not see this" clears it too, while a transient failure keeps
 * the last good content and says it is stale.
 */
export function useMyDay(): MyDayState {
  const client = useApiClient();
  const { workspaceId } = useWorkspace();
  const activeLoad = useRef<AbortController | null>(null);
  const operations = useRef(new Set<AbortController>());
  const latest = useRef<MyDay | null>(null);
  const [status, setStatus] = useState<MyDayStatus>('loading');
  const [day, setDay] = useState<MyDay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [staleReason, setStaleReason] = useState<string | null>(null);

  const load = useCallback(async (): Promise<MyDay | null> => {
    activeLoad.current?.abort();
    const controller = new AbortController();
    activeLoad.current = controller;

    try {
      const next = await client.query(coreMyDay.myDay(workspaceId), {
        signal: controller.signal,
        forceRefresh: true,
      });
      if (controller.signal.aborted || activeLoad.current !== controller) return null;
      latest.current = next;
      setDay(next);
      setError(null);
      setStaleReason(null);
      setStatus('ready');
      return next;
    } catch (reason) {
      if (controller.signal.aborted || activeLoad.current !== controller || isCanceledError(reason))
        return null;
      const protectedRefusal =
        isNixApiError(reason) &&
        (reason.status === 403 || reason.status === 404 || reason.status === 423);
      if (latest.current === null || protectedRefusal) {
        latest.current = null;
        setDay(null);
        setError(loadError(reason));
        setStaleReason(null);
        setStatus('error');
      } else {
        setStaleReason(
          'My Day could not be refreshed, so what is shown may be out of date. Reload to check.',
        );
      }
      return null;
    } finally {
      if (activeLoad.current === controller) activeLoad.current = null;
    }
  }, [client, workspaceId]);

  const reload = useCallback(async (): Promise<void> => {
    await load();
  }, [load]);

  const run = useCallback(
    async (write: (signal: AbortSignal) => Promise<unknown>, fallback: string) => {
      const controller = new AbortController();
      operations.current.add(controller);
      try {
        await write(controller.signal);
      } catch (reason) {
        return isCanceledError(reason) ? fallback : writeReason(reason, fallback);
      } finally {
        operations.current.delete(controller);
      }
      // The write is done whatever the re-read does; a failed re-read says so through staleReason.
      await load();
      return null;
    },
    [load],
  );

  const completeTask = useCallback(
    async (row: MyDayTaskRow): Promise<string | null> => {
      const { action } = row;
      if (action.kind === 'occurrence' && action.occurredOn !== null) {
        const occurredOn = action.occurredOn;
        return run(
          (signal) =>
            client.execute(coreRecurrence.completeOccurrence(row.itemId, occurredOn), { signal }),
          'That occurrence could not be completed.',
        );
      }

      // A bare completion write would finish a whole series if this task started repeating after
      // it was listed. Re-read first and refuse if the row is not what was shown. This narrows the
      // window to one round trip; Core has no atomic complete-task command to close it.
      const fresh = await load();
      const key = action.key;
      const same = fresh?.tasks.rows.find(
        (candidate) =>
          candidate.itemId === row.itemId &&
          candidate.action.kind === 'property' &&
          candidate.action.key === key,
      );
      if (key === null || same === undefined) {
        return 'This task changed since it was listed. The list has been refreshed; try again.';
      }

      return run(
        (signal) =>
          client.execute(coreStructure.setItemProperties(row.itemId, { [key]: true }), { signal }),
        'That task could not be completed.',
      );
    },
    [client, load, run],
  );

  const checkIn = useCallback(
    (
      row: MyDayHabitRow,
      input: { readonly completed: boolean; readonly quantity: number | null },
    ): Promise<string | null> =>
      run(
        (signal) =>
          client.execute(coreHabits.checkIn(row.itemId, row.occurrence.date, input), { signal }),
        'That check-in could not be saved.',
      ),
    [client, run],
  );

  const undoCheckIn = useCallback(
    (row: MyDayHabitRow): Promise<string | null> =>
      run(
        (signal) =>
          client.execute(coreHabits.undoCheckIn(row.itemId, row.occurrence.date), { signal }),
        'That check-in could not be undone.',
      ),
    [client, run],
  );

  const readHabit = useCallback(
    async (row: MyDayHabitRow): Promise<HabitTracker | string> => {
      const { date } = row.occurrence;
      try {
        return await client.query(coreHabits.readHabit(row.itemId, date, date), {
          forceRefresh: true,
        });
      } catch (reason) {
        return writeReason(reason, 'This habit’s settings could not be read.');
      }
    },
    [client],
  );

  const saveHabit = useCallback(
    (row: MyDayHabitRow, title: string, settings: SetHabitInput): Promise<string | null> =>
      run(async (signal) => {
        await client.execute(coreHabits.setHabit(row.itemId, settings), { signal });
        if (title !== row.title) {
          await client.execute(coreItems.renameItem(workspaceId, row.itemId, title), { signal });
        }
      }, 'The habit could not be saved.'),
    [client, run, workspaceId],
  );

  // Scope change: drop the previous workspace's content before anything else renders it.
  useEffect(() => {
    let active = true;
    const pending = operations.current;
    latest.current = null;
    queueMicrotask(() => {
      if (!active) return;
      setDay(null);
      setError(null);
      setStaleReason(null);
      setStatus('loading');
      void load();
    });
    return () => {
      active = false;
      activeLoad.current?.abort();
      for (const controller of pending) controller.abort();
      pending.clear();
    };
  }, [load]);

  useEffect(
    () =>
      onItemChildrenChanged((detail) => {
        if (detail.workspaceId === workspaceId) void load();
      }),
    [load, workspaceId],
  );

  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  // Yesterday's actions must not sit under today's heading: re-read at the next midnight of the
  // task day or of any habit's own zone, whichever comes first.
  useEffect(() => {
    if (day === null) return undefined;
    const now = new Date();
    const zones = new Set([day.taskTimezone, ...day.habits.rows.map((row) => row.timezone)]);
    const wait = Math.min(
      MAX_TIMER_MS,
      ...[...zones].map((zone) => msUntilMidnight(zone, now) + 1000),
    );
    const timer = setTimeout(() => {
      void load();
    }, wait);
    return () => {
      clearTimeout(timer);
    };
  }, [day, load]);

  return {
    status,
    day,
    error,
    staleReason,
    reload,
    completeTask,
    checkIn,
    undoCheckIn,
    readHabit,
    saveHabit,
  };
}
