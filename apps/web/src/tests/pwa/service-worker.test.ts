// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function worker() {
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const fallback = new Response('Offline fallback');
  const cache = {
    match: vi.fn(() => Promise.resolve(fallback)),
    put: vi.fn(),
    addAll: vi.fn(() => Promise.resolve(undefined)),
  };
  const fetch = vi.fn(() => Promise.reject(new Error('offline')));
  const skipWaiting = vi.fn();
  runInNewContext(
    readFileSync(new URL('../../../public/service-worker.js', import.meta.url), 'utf8'),
    {
      self: {
        addEventListener: (name: string, handler: (event: Record<string, unknown>) => void) =>
          handlers.set(name, handler),
        location: { origin: 'https://nix.test' },
        skipWaiting,
      },
      caches: { open: () => Promise.resolve(cache) },
      fetch,
      URL,
      Response,
    },
  );
  return { handlers, cache, fetch, skipWaiting, fallback };
}
describe('PWA caching boundaries', () => {
  it('never intercepts authenticated API, sign-in or capability requests', () => {
    const runtime = worker();
    for (const path of [
      '/auth/session',
      '/api/v1/me',
      '/public/v1/files/x',
      '/collab/documents/x/ws',
      '/internal/jobs',
      '/forms/private-link',
    ]) {
      const respondWith = vi.fn();
      runtime.handlers.get('fetch')?.({
        request: { method: 'GET', url: `https://nix.test${path}`, mode: 'navigate' },
        respondWith,
      });
      expect(respondWith).not.toHaveBeenCalled();
    }
  });
  it('provides an offline screen for a failed workspace navigation without caching its HTML', async () => {
    const runtime = worker();
    let response: Promise<Response> | undefined;
    runtime.handlers.get('fetch')?.({
      request: { method: 'GET', url: 'https://nix.test/w/workspace', mode: 'navigate' },
      respondWith: (value: Promise<Response>) => {
        response = value;
      },
    });
    expect(await response).toBe(runtime.fallback);
    expect(runtime.cache.put).not.toHaveBeenCalled();
  });
  it('only activates early after an explicit update message', () => {
    const runtime = worker();
    runtime.handlers.get('install')?.({ waitUntil: () => undefined });
    expect(runtime.skipWaiting).not.toHaveBeenCalled();
    runtime.handlers.get('message')?.({ data: { type: 'ACTIVATE_UPDATE' } });
    expect(runtime.skipWaiting).toHaveBeenCalledOnce();
  });
});
