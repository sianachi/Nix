import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileThumbnail, fileThumbnailKind } from '../../thumbnails/use-file-thumbnail';

const client = vi.hoisted(() => ({ query: vi.fn() }));
const query = client.query;
const revokeObjectURL = vi.fn();
vi.mock('../../api/api-client-provider', () => ({ useApiClient: () => client }));
vi.mock('../../thumbnails/use-pdf-thumbnail', () => ({
  usePdfThumbnail: () => ({ status: 'none', url: null }),
}));

beforeEach(() => {
  query.mockReset().mockResolvedValue({ url: 'http://localhost:7070/thumbnail' });
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL });
  vi.mocked(fetch).mockImplementation(() =>
    Promise.resolve(new Response(new Blob(['jpeg'], { type: 'image/jpeg' }))),
  );
});

describe('file thumbnails keep body authorization at Core', () => {
  const options = {
    itemId: 'file',
    version: 'one',
    enabled: true,
    fileName: 'cover.png',
    mediaType: 'image/png',
    hasServerThumbnail: undefined,
  };
  it('authorizes each mount, omits credentials on object storage, and releases its URL', async () => {
    const first = renderHook(() => useFileThumbnail(options));
    await waitFor(() => {
      expect(first.result.current.status).toBe('ready');
    });
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/v1/items/file/file/thumbnail' }),
      expect.objectContaining({ forceRefresh: true }),
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ credentials: 'omit', redirect: 'error' }),
    );
    first.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test');
    const second = renderHook(() => useFileThumbnail(options));
    await waitFor(() => {
      expect(second.result.current.status).toBe('ready');
    });
    expect(query).toHaveBeenCalledTimes(2);
  });
  it('does not fetch bytes when authorization fails', async () => {
    query.mockRejectedValue(new Error('Unavailable'));
    const view = renderHook(() => useFileThumbnail(options));
    await waitFor(() => {
      expect(view.result.current.status).toBe('error');
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(view.result.current.url).toBeNull();
  });
  it('does not start work for an offscreen card', () => {
    expect(
      renderHook(() => useFileThumbnail({ ...options, enabled: false })).result.current.status,
    ).toBe('idle');
    expect(query).not.toHaveBeenCalled();
  });
  it('recognizes EPUB covers by extension even when sniffed as zip', () => {
    expect(fileThumbnailKind('Book.EPUB', 'application/zip')).toBe('epub');
    expect(fileThumbnailKind('cover.svg', 'image/svg+xml')).toBe('other');
  });
});
