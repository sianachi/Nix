import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCanvasLibrary } from '../../editor/use-canvas-library';

/**
 * A stable reference, not an inline arrow inside the factory: `useAuth()` is a dependency of the
 * hook's own effect, and a new function identity on every call would retrigger it on every render
 * the way an unstable prop retriggers any effect that depends on it.
 */
const getAccessToken = (): Promise<string> => Promise.resolve('token');

vi.mock('../../auth/auth-provider', () => ({
  useAuth: () => ({ getAccessToken }),
}));

/**
 * The library is per caller, not per canvas: one `GET`/`PUT` pair against
 * `/api/v1/me/canvas-library`, with no item or workspace in the URL. These tests are about the
 * hook's own contract with that endpoint, not about Excalidraw, which is why nothing here renders
 * `CanvasEditor`.
 */
describe('the caller’s own canvas library', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts loading and then reports what Core has saved', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [{ id: 'shape-1' }] }), { status: 200 }),
    );

    const { result } = renderHook(() => useCanvasLibrary());

    expect(result.current.status).toBe('loading');

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    expect(result.current.items).toEqual([{ id: 'shape-1' }]);
    // Read off the recorded call rather than matched with a nested `expect.objectContaining`,
    // which returns `any` and makes the surrounding object literal an unsafe assignment. The
    // headers are a plain object here, so asserting them is both stricter and simpler.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/me/canvas-library');
    expect(init.headers).toEqual({
      accept: 'application/json',
      authorization: 'Bearer token',
    });
  });

  it('reports an empty library as an error rather than silently substituting one when the read fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));

    const { result } = renderHook(() => useCanvasLibrary());

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });

    expect(result.current.items).toEqual([]);
  });

  it('saves the caller’s complete library, once loading has finished', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [{ id: 'shape-2' }] }), { status: 200 }),
      );

    const { result } = renderHook(() => useCanvasLibrary());

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    act(() => {
      result.current.save([{ id: 'shape-2' }]);
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const [path, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(path).toBe('/api/v1/me/canvas-library');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ items: [{ id: 'shape-2' }] });
  });

  it('does not save back to Core before the initial read has resolved', async () => {
    fetchMock.mockImplementation(() => new Promise(() => undefined));

    const { result } = renderHook(() => useCanvasLibrary());

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // Excalidraw fires `onLibraryChange` once on mount with whatever it booted with, before this
    // hook's own read has necessarily returned - saving that would overwrite Core's copy with an
    // empty one.
    act(() => {
      result.current.save([]);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
