import { habits, isNixApiError, type HabitTracker, type SetHabitInput } from '@nix/api-client';
import { useApiClient } from '../../api/api-client-provider';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type HabitLoadState = 'loading' | 'ready' | 'partial' | 'error';

export interface HabitsState {
  readonly status: HabitLoadState;
  readonly trackers: ReadonlyMap<string, HabitTracker>;
  readonly error: string | null;
  readonly reload: () => void;
  readonly saveHabit: (habitId: string, input: SetHabitInput) => Promise<string | null>;
  readonly saveCheckIn: (
    habitId: string,
    day: string,
    completed: boolean,
    quantity: number | null,
  ) => Promise<string | null>;
  readonly undoCheckIn: (habitId: string, day: string) => Promise<string | null>;
  readonly setStatus: (
    habitId: string,
    status: 'active' | 'paused' | 'archived',
  ) => Promise<string | null>;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : 'Habit data could not be loaded.';
}

export function useHabits(habitIds: readonly string[], from: string, to: string): HabitsState {
  const client = useApiClient();
  const writes = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    writes.current = controller;
    return () => {
      controller.abort();
    };
  }, [client]);
  const [generation, setGeneration] = useState(0);
  const [status, setLoadStatus] = useState<HabitLoadState>('loading');
  const [trackers, setTrackers] = useState<ReadonlyMap<string, HabitTracker>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const ids = useMemo(() => [...new Set(habitIds)], [habitIds]);
  const reload = useCallback(() => {
    setGeneration((value) => value + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setLoadStatus('loading');
      setError(null);
    });
    const readAll = async (): Promise<PromiseSettledResult<HabitTracker>[]> => {
      const results: PromiseSettledResult<HabitTracker>[] = [];
      let cursor = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const index = cursor++;
          const id = ids[index];
          if (id === undefined || controller.signal.aborted) return;
          try {
            results[index] = {
              status: 'fulfilled',
              value: await client.query(habits.readHabit(id, from, to), {
                signal: controller.signal,
                forceRefresh: true,
              }),
            };
          } catch (reason) {
            results[index] = { status: 'rejected', reason };
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(6, ids.length) }, worker));
      return results;
    };
    void readAll().then((results) => {
      if (controller.signal.aborted) return;
      const next = new Map<string, HabitTracker>();
      const failures: unknown[] = [];
      results.forEach((result, index) => {
        const id = ids[index];
        if (id === undefined || controller.signal.aborted) return;
        if (result.status === 'fulfilled') next.set(id, result.value);
        else if (!(isNixApiError(result.reason) && result.reason.code === 'habits.not_configured'))
          failures.push(result.reason);
      });
      setTrackers(next);
      setLoadStatus(failures.length === 0 ? 'ready' : next.size > 0 ? 'partial' : 'error');
      setError(failures.length === 0 ? null : messageFor(failures[0]));
    });
    return () => {
      controller.abort();
    };
  }, [client, from, generation, ids, to]);

  const saveCheckIn = useCallback(
    async (habitId: string, day: string, completed: boolean, quantity: number | null) => {
      try {
        await client.execute(habits.checkIn(habitId, day, { completed, quantity }), {
          signal: writes.current?.signal,
        });
        setGeneration((value) => value + 1);
        return null;
      } catch (reason) {
        return messageFor(reason);
      }
    },
    [client],
  );

  const saveHabit = useCallback(
    async (habitId: string, input: SetHabitInput) => {
      try {
        await client.execute(habits.setHabit(habitId, input), { signal: writes.current?.signal });
        setGeneration((value) => value + 1);
        return null;
      } catch (reason) {
        return messageFor(reason);
      }
    },
    [client],
  );

  const undoCheckIn = useCallback(
    async (habitId: string, day: string) => {
      try {
        await client.execute(habits.undoCheckIn(habitId, day), { signal: writes.current?.signal });
        setGeneration((value) => value + 1);
        return null;
      } catch (reason) {
        return messageFor(reason);
      }
    },
    [client],
  );

  const setStatus = useCallback(
    async (habitId: string, status: 'active' | 'paused' | 'archived') => {
      try {
        await client.execute(habits.setStatus(habitId, { status }), {
          signal: writes.current?.signal,
        });
        setGeneration((value) => value + 1);
        return null;
      } catch (reason) {
        return messageFor(reason);
      }
    },
    [client],
  );

  return {
    status,
    trackers,
    error,
    reload,
    saveHabit,
    saveCheckIn,
    undoCheckIn,
    setStatus,
  };
}
