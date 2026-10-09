import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetConnection } from '@nix/api-client';
import { usePetRuntime } from '../../pets/use-pet-runtime';

const client = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn() }));
vi.mock('../../api/api-client-provider', () => ({ useApiClient: () => client }));

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const PET_ID = '22222222-2222-4222-8222-222222222222';

function connection(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'chatgpt',
    status: 'connected',
    reason: '',
    canConnect: false,
    verificationUrl: '',
    userCode: '',
    state: 'idle',
    messages: [],
    history: [],
    models: [],
    tools: [],
    revision: 0,
    lockedRead: false,
    ...overrides,
  };
}

function watchQuery(call: unknown): { workspaceId: string; petId: string; after: number } {
  return (call as { query: { workspaceId: string; petId: string; after: number } }).query;
}

describe('usePetRuntime watch loop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    client.query.mockReset();
    client.execute.mockReset();
    client.execute.mockResolvedValue(connection());
    document.dispatchEvent(new Event('visibilitychange'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('starts the first watch at after: 0, then advances after as the revision grows', async () => {
    client.query
      .mockResolvedValueOnce(connection({ revision: 1 }))
      .mockResolvedValue(connection({ revision: 1 }));
    renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, 'chat', true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(watchQuery(client.query.mock.calls[0]?.[0]).after).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    const laterCall: unknown = client.query.mock.calls.at(-1)?.[0];
    expect(watchQuery(laterCall).after).toBe(1);
  });

  it('applies a newer revision but ignores a stale one that arrives after it', async () => {
    client.query
      .mockResolvedValueOnce(connection({ revision: 3, reason: 'third' }))
      .mockResolvedValueOnce(connection({ revision: 2, reason: 'stale-second' }))
      .mockResolvedValue(connection({ revision: 3, reason: 'third' }));
    const { result } = renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, 'chat', true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.runtime?.revision).toBe(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    // The stale (lower) revision returned by the second call must never overwrite the newer
    // state already applied from the first.
    expect(result.current.runtime?.revision).toBe(3);
    expect(result.current.runtime?.reason).toBe('third');
  });

  it('backs off 1s, 2s, 4s, then caps at 10s after consecutive watch failures', async () => {
    client.query.mockRejectedValue(new Error('network down'));
    renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, 'chat', true));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(client.query).toHaveBeenCalledTimes(1); // failure #1, no backoff owed yet

    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(client.query).toHaveBeenCalledTimes(1); // still within the 1s backoff after failure #1
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(client.query).toHaveBeenCalledTimes(2); // failure #2 fires exactly at the 1s mark

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1999);
    });
    expect(client.query).toHaveBeenCalledTimes(2); // within the 2s backoff after failure #2
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(client.query).toHaveBeenCalledTimes(3); // failure #3 fires exactly at the 2s mark

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3999);
    });
    expect(client.query).toHaveBeenCalledTimes(3); // within the 4s backoff after failure #3
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(client.query).toHaveBeenCalledTimes(4); // failure #4 fires exactly at the 4s mark, backoff caps at 10s

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9999);
    });
    expect(client.query).toHaveBeenCalledTimes(4); // within the capped 10s backoff after failure #4
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(client.query).toHaveBeenCalledTimes(5); // failure #5 fires exactly at the 10s cap
  });

  it('shows the load error only after two consecutive failures', async () => {
    client.query.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, 'chat', true));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.error).toBe('');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1001);
    });
    expect(result.current.error).toContain('could not be loaded');
  });

  it('pauses while the document is hidden and resumes immediately once visible', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    client.query.mockResolvedValue(connection({ revision: 1 }));
    renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, 'chat', true));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(client.query).not.toHaveBeenCalled();

    visibility.mockReturnValue('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('stops watching once a closed panel has settled and is idle', async () => {
    client.query.mockResolvedValue(connection({ revision: 1, state: 'success', tools: [] }));
    renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, 'chat', false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const callsAfterSettling = client.query.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    // No further network requests - only the local `IDLE_RECHECK_MS` check, which issues none.
    expect(client.query.mock.calls.length).toBe(callsAfterSettling);
  });

  it('aborts the in-flight watch on unmount, so a late response is never applied', async () => {
    client.query.mockResolvedValue(connection({ revision: 1 }));
    const { unmount } = renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, 'chat', true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const callsBeforeUnmount = client.query.mock.calls.length;
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(client.query.mock.calls.length).toBe(callsBeforeUnmount);
  });
});

describe('usePetRuntime errorKind and retryWatch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    client.query.mockReset();
    client.execute.mockReset();
    client.execute.mockResolvedValue(connection());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('marks a watch failure "load", offering "Retry now" behaviour via retryWatch', async () => {
    client.query.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, 'chat', true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1001);
    });
    expect(result.current.errorKind).toBe('load');
  });

  it('retryWatch wakes the loop immediately, skipping the remaining backoff delay', async () => {
    client.query
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue(connection({ revision: 1 }));
    const { result } = renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, 'chat', true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(client.query).toHaveBeenCalledTimes(1);
    act(() => {
      result.current.retryWatch();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(client.query).toHaveBeenCalledTimes(2);
  });

  it('marks a failed send "send", never a load or command failure', async () => {
    // Never resolves, so this test isolates the send path from the watch loop.
    client.query.mockImplementation(() => new Promise<never>(() => undefined));
    client.execute.mockImplementation((endpoint: unknown) => {
      const operation = (endpoint as { body?: { operation?: string } }).body?.operation;
      if (operation === 'send') return Promise.reject(new Error('boom'));
      return Promise.resolve(connection());
    });
    const { result } = renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, 'chat', true));
    await act(async () => {
      await result.current.send({ text: 'hi', model: '', workspaceAccess: false });
    });
    expect(result.current.errorKind).toBe('send');
  });

  it('keeps a failed send visible across later successful watches', async () => {
    client.query.mockResolvedValue(connection({ revision: 1 }));
    client.execute.mockImplementation((endpoint: unknown) => {
      const operation = (endpoint as { body?: { operation?: string } }).body?.operation;
      if (operation === 'send') return Promise.reject(new Error('boom'));
      return Promise.resolve(connection());
    });
    const { result } = renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, 'chat', true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await result.current.send({ text: 'hi', model: '', workspaceAccess: false });
    });
    expect(result.current.errorKind).toBe('send');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(client.query.mock.calls.length).toBeGreaterThan(1);
    expect(result.current.errorKind).toBe('send');
    expect(result.current.error).not.toBe('');
  });

  it('marks a failed one-off command (reload) "command"', async () => {
    // Never resolves - see the send test above for why.
    client.query.mockImplementation(() => new Promise<never>(() => undefined));
    client.execute.mockImplementation((endpoint: unknown) => {
      const operation = (endpoint as { body?: { operation?: string } }).body?.operation;
      if (operation === 'read') return Promise.reject(new Error('boom'));
      return Promise.resolve(connection());
    });
    const { result } = renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, 'chat', true));
    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.errorKind).toBe('command');
  });

  it('keeps the same request id when a failed send is retried unedited', async () => {
    let sendAttempts = 0;
    client.execute.mockImplementation((endpoint: unknown) => {
      const body = (endpoint as { body?: { operation?: string } }).body;
      if (body?.operation === 'send') {
        sendAttempts += 1;
        return sendAttempts === 1
          ? Promise.reject(new Error('boom'))
          : Promise.resolve(connection());
      }
      return Promise.resolve(connection());
    });
    client.query.mockResolvedValue(connection());
    const { result } = renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, 'chat', true));
    await act(async () => {
      await result.current.send({ text: 'hi', model: '', workspaceAccess: false });
    });
    await act(async () => {
      await result.current.send({ text: 'hi', model: '', workspaceAccess: false });
    });
    const sendBodies = client.execute.mock.calls
      .map(([endpoint]) => (endpoint as { body?: { operation?: string; requestId?: string } }).body)
      .filter((body) => body?.operation === 'send');
    expect(sendBodies).toHaveLength(2);
    expect(sendBodies[0]?.requestId).toBe(sendBodies[1]?.requestId);
  });

  it("sends the owner's day and zone with every message, and a workspace map only when given", async () => {
    client.query.mockResolvedValue(connection());
    vi.setSystemTime(new Date('2026-10-09T12:00:00Z'));
    const { result } = renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, 'chat', true));
    const map = [{ id: WORKSPACE_ID, title: 'Tasks', type: 'note', viewKinds: ['board'] }];
    await act(async () => {
      await result.current.send({
        text: 'hi',
        model: '',
        workspaceAccess: true,
        workspaceMap: map,
      });
    });
    await act(async () => {
      await result.current.send({ text: 'and then?', model: '', workspaceAccess: true });
    });
    const sendBodies = client.execute.mock.calls
      .map(([endpoint]) => (endpoint as { body?: Record<string, unknown> }).body)
      .filter((body) => body?.operation === 'send');
    expect(sendBodies).toHaveLength(2);
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    for (const body of sendBodies) {
      expect(body?.timeZone).toBe(zone);
      expect(body?.today).toMatch(/^2026-10-(08|09|10)$/);
    }
    expect(sendBodies[0]?.workspaceMap).toEqual([{ ...map[0], viewKinds: ['board'] }]);
    expect(sendBodies[1]?.workspaceMap).toBeNull();
  });

  it('ignores a setRuntime call bound to a stale generation once the mode has moved on', async () => {
    client.query.mockResolvedValue(connection());
    const { result, rerender } = renderHook(
      ({ mode }: { mode: 'chat' | 'consult' }) => usePetRuntime(WORKSPACE_ID, PET_ID, mode, true),
      { initialProps: { mode: 'chat' } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // Captured before the mode switch - the same stale reference a `PetWorkTools` instance's
    // in-flight `tool_result` promise would still be holding once it resolves late.
    const staleSetRuntime = result.current.setRuntime;
    rerender({ mode: 'consult' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      staleSetRuntime(connection({ revision: 999, reason: 'stale-mode' }) as PetConnection);
    });
    expect(result.current.runtime?.reason).not.toBe('stale-mode');
  });
});
