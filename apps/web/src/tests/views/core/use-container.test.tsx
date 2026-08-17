import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useContainer } from '../../../views/core/use-container';
import { item } from '../../api-stub';

const getAccessToken = (): Promise<string> => Promise.resolve('token');

vi.mock('../../../auth/auth-provider', () => ({
  useAuth: () => ({ getAccessToken }),
}));

describe('container loading', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('cursor=')) return new Promise<Response>(() => undefined);
      if (url.endsWith('/schema')) {
        return Promise.resolve(
          new Response(JSON.stringify({ properties: [], declared: [], inherit: true })),
        );
      }
      if (url.endsWith('/views')) {
        return Promise.resolve(
          new Response(JSON.stringify({ views: [], unrenderable: [], default: 'document' })),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            items: [
              item({
                id: 'a1000000-0000-4000-8000-000000000010',
                workspaceId: '00000000-0000-4000-8000-000000000001',
                parentId: 'a1000000-0000-4000-8000-000000000020',
                title: 'First page',
              }),
            ],
            nextCursor: 'next-page',
          }),
        ),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('cancels an unfinished page walk when its consumer unmounts', async () => {
    const { unmount } = renderHook(() => useContainer('a1000000-0000-4000-8000-000000000020'));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('cursor='))).toBe(true);
    });
    const cursorCall = fetchMock.mock.calls.find(([url]) => String(url).includes('cursor='));
    const signal = (cursorCall?.[1] as RequestInit | undefined)?.signal;

    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});
