import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
});
