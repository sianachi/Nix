import { act, renderHook, waitFor } from '@testing-library/react';
import { NixApiError, type MyDay, type MyDayHabitRow, type MyDayTaskRow } from '@nix/api-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { msUntilMidnight, useMyDay } from '../../my-day/use-my-day';

const WORKSPACE = 'a1111111-1111-4111-8111-111111111111';
const OTHER = 'a9999999-9999-4999-8999-999999999999';
const TASK = 'a2222222-2222-4222-8222-222222222222';
const HABIT = 'a3333333-3333-4333-8333-333333333333';

const query = vi.fn<(endpoint: unknown, options?: unknown) => Promise<MyDay>>();
const execute = vi.fn<(endpoint: unknown, options?: unknown) => Promise<unknown>>();
let workspaceId = WORKSPACE;

// One object, as the provider gives: a new client per render would re-run the hook's scope effect.
const client = { query, execute };
vi.mock('../../api/api-client-provider', () => ({ useApiClient: () => client }));
vi.mock('../../workspaces/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId }),
}));

const complete = { kind: 'complete' as const, reasons: [] };
const limits = { candidates: 200, rows: 100 };

function property(overrides: Partial<MyDayTaskRow> = {}): MyDayTaskRow {
  return {
    itemId: TASK,
    containerId: null,
    containerTitle: 'Inbox',
    title: 'Write report',
    section: 'today',
    dueDay: '2026-10-16',
    startDay: null,
    priority: null,
    estimate: null,
    action: { kind: 'property', key: 'completion', occurredOn: null },
    ...overrides,
  };
}

const habit: MyDayHabitRow = {
  itemId: HABIT,
  containerId: null,
  containerTitle: null,
  title: 'Stretch',
  timezone: 'Pacific/Kiritimati',
  occurrence: {
    date: '2026-10-17',
    scheduled: true,
    state: 'scheduled',
    target: 1,
    unit: 'times',
    quantity: null,
    completed: false,
  },
};

function day(tasks: MyDayTaskRow[] = [property()], habits: MyDayHabitRow[] = [habit]): MyDay {
  return {
    workspaceId,
    evaluatedAt: '2026-10-16T12:00:00+00:00',
    taskDay: '2026-10-16',
    taskTimezone: 'UTC',
    tasks: { rows: tasks, coverage: complete, limits },
    habits: { rows: habits, coverage: complete, limits: { candidates: 24, rows: 24 } },
  };
}

function problem(status: number, code: string): NixApiError {
  return new NixApiError({ kind: 'problem', code, message: code, status });
}

beforeEach(() => {
  vi.clearAllMocks();
  workspaceId = WORKSPACE;
  query.mockResolvedValue(day());
  execute.mockResolvedValue({});
});

async function ready() {
  const hook = renderHook(() => useMyDay());
  await waitFor(() => {
    expect(hook.result.current.status).toBe('ready');
  });
  return hook;
}

describe('finishing a task', () => {
  it('writes the completion key on the original item, then re-reads', async () => {
    const { result } = await ready();
    const reads = query.mock.calls.length;

    let outcome: string | null = 'unset';
    await act(async () => {
      outcome = await result.current.completeTask(property());
    });

    expect(outcome).toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      method: 'PATCH',
      path: `/api/v1/items/${TASK}/properties`,
      body: { properties: { completion: true } },
    });
    // One read to check the row is unchanged before writing, one after the write.
    expect(query.mock.calls.length).toBe(reads + 2);
  });

  it('refuses without writing when the row is no longer a plain completion', async () => {
    const { result } = await ready();
    query.mockResolvedValue(
      day([property({ action: { kind: 'occurrence', key: null, occurredOn: '2026-10-16' } })]),
    );

    let outcome: string | null = null;
    await act(async () => {
      outcome = await result.current.completeTask(property());
    });

    expect(outcome).toContain('changed since it was listed');
    expect(execute).not.toHaveBeenCalled();
  });

  it('completes one occurrence by its returned date, never the whole series', async () => {
    const { result } = await ready();

    await act(async () => {
      await result.current.completeTask(
        property({ action: { kind: 'occurrence', key: null, occurredOn: '2026-10-16' } }),
      );
    });

    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      method: 'POST',
      path: `/api/v1/items/${TASK}/recurrence/completions`,
      body: { occurredOn: '2026-10-16' },
    });
  });

  it('reports why a write was refused and leaves the list to the next read', async () => {
    const { result } = await ready();
    execute.mockRejectedValue(
      new NixApiError({
        kind: 'problem',
        code: 'items.forbidden',
        message: 'refused',
        status: 403,
        detail: 'You cannot edit this.',
      }),
    );

    let outcome: string | null = null;
    await act(async () => {
      outcome = await result.current.completeTask(
        property({ action: { kind: 'occurrence', key: null, occurredOn: '2026-10-16' } }),
      );
    });

    expect(outcome).toBe('You cannot edit this.');
  });
});

describe('a habit', () => {
  it('checks in on the habit’s own day, not the task day', async () => {
    const { result } = await ready();

    await act(async () => {
      await result.current.checkIn(habit, { completed: true, quantity: null });
    });

    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      method: 'PUT',
      path: `/api/v1/items/${HABIT}/habit/check-ins/2026-10-17`,
      body: { completed: true, quantity: null },
    });
  });

  it('undoes a check-in on that same day', async () => {
    const { result } = await ready();

    await act(async () => {
      await result.current.undoCheckIn(habit);
    });

    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      method: 'DELETE',
      path: `/api/v1/items/${HABIT}/habit/check-ins/2026-10-17`,
    });
  });
});

describe('reading', () => {
  it('keeps the last good day and says it is stale when a refresh fails', async () => {
    const { result } = await ready();
    query.mockRejectedValue(new Error('offline'));

    await act(async () => {
      await result.current.reload();
    });

    expect(result.current.status).toBe('ready');
    expect(result.current.day?.tasks.rows).toHaveLength(1);
    expect(result.current.staleReason).toContain('could not be refreshed');
  });

  it('clears the day when a refresh is refused as not visible', async () => {
    const { result } = await ready();
    query.mockRejectedValue(problem(404, 'workspaces.not_found'));

    await act(async () => {
      await result.current.reload();
    });

    expect(result.current.day).toBeNull();
    expect(result.current.status).toBe('error');
  });

  it('drops the previous workspace’s day when the scope changes', async () => {
    const { result, rerender } = await ready();
    query.mockReturnValue(new Promise<MyDay>(() => undefined));
    workspaceId = OTHER;

    rerender();

    await waitFor(() => {
      expect(result.current.day).toBeNull();
    });
    expect(result.current.status).toBe('loading');
  });
});

describe('the next midnight', () => {
  it('is measured in the zone asked about', () => {
    const noonUtc = new Date('2026-10-16T12:00:00Z');

    expect(msUntilMidnight('UTC', noonUtc)).toBe(12 * 3_600_000);
    // 12:00 UTC is 02:00 on the 17th in Kiritimati (+14).
    expect(msUntilMidnight('Pacific/Kiritimati', noonUtc)).toBe(22 * 3_600_000);
  });
});
