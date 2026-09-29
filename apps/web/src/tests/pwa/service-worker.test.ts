// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function worker(
  options: {
    readonly storedPushKey?: string;
    readonly windowClients?: readonly {
      readonly focus: () => Promise<unknown>;
      readonly navigate?: (url: string) => Promise<unknown>;
    }[];
  } = {},
) {
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const fallback = new Response('Offline fallback');
  const stored = options.storedPushKey;
  const pushKeyCache = {
    match: vi.fn(() =>
      Promise.resolve(
        stored === undefined
          ? undefined
          : new Response(JSON.stringify({ applicationServerKey: stored })),
      ),
    ),
    put: vi.fn(),
    delete: vi.fn(),
  };
  const cache = {
    match: vi.fn(() => Promise.resolve(fallback)),
    put: vi.fn(),
    addAll: vi.fn(() => Promise.resolve(undefined)),
  };
  // The worker calls this both ways: `fetch(request)` in the offline-navigation fallback, with a
  // duck-typed request object rather than a real `Request` (this file runs under the `node`
  // environment, which has neither), and `fetch(url, init)` directly for the push-subscription
  // re-report - so the mock has to accept either shape rather than assume a bare string.
  const fetch = vi.fn<
    (input: string | { readonly url: string }, init?: RequestInit) => Promise<Response>
  >((input) => {
    const url = typeof input === 'string' ? input : input.url;
    return url.includes('/api/v1/me/push-subscriptions')
      ? Promise.resolve(new Response(null, { status: 201 }))
      : Promise.reject(new Error('offline'));
  });
  const skipWaiting = vi.fn();
  const showNotification = vi.fn(() => Promise.resolve(undefined));
  const subscribe = vi.fn(() =>
    Promise.resolve({
      toJSON: () => ({ endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } }),
    }),
  );
  const openWindow = vi.fn(() => Promise.resolve(undefined));
  runInNewContext(
    readFileSync(new URL('../../../public/service-worker.js', import.meta.url), 'utf8'),
    {
      self: {
        addEventListener: (name: string, handler: (event: Record<string, unknown>) => void) =>
          handlers.set(name, handler),
        location: { origin: 'https://nix.test' },
        skipWaiting,
        registration: { showNotification, pushManager: { subscribe } },
        clients: {
          matchAll: vi.fn(() => Promise.resolve(options.windowClients ?? [])),
          openWindow,
        },
      },
      caches: {
        open: (name: string) => Promise.resolve(name === 'nix-push-key' ? pushKeyCache : cache),
      },
      fetch,
      URL,
      Response,
      atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
    },
  );
  return {
    handlers,
    cache,
    pushKeyCache,
    fetch,
    skipWaiting,
    fallback,
    showNotification,
    subscribe,
    openWindow,
  };
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

describe('push notifications', () => {
  it('shows a notification with the payload title, body, tag and url', async () => {
    const runtime = worker();
    let waited: Promise<unknown> | undefined;
    runtime.handlers.get('push')?.({
      data: {
        json: () => ({
          title: 'Due today',
          body: 'Ship the release',
          tag: 'reminder',
          url: '/w/x/y',
        }),
      },
      waitUntil: (promise: Promise<unknown>) => {
        waited = promise;
      },
    });
    await waited;
    expect(runtime.showNotification).toHaveBeenCalledWith('Due today', {
      body: 'Ship the release',
      tag: 'reminder',
      icon: '/nix-icon-192.png',
      data: { url: '/w/x/y' },
    });
  });

  it('falls back to a default title when the payload is missing or unparsable', async () => {
    const runtime = worker();
    let waited: Promise<unknown> | undefined;
    runtime.handlers.get('push')?.({
      data: undefined,
      waitUntil: (promise: Promise<unknown>) => {
        waited = promise;
      },
    });
    await waited;
    expect(runtime.showNotification).toHaveBeenCalledWith(
      'Nix',
      expect.objectContaining({ body: '' }),
    );
  });

  it('focuses and navigates an existing window to the notification url', async () => {
    const navigate = vi.fn(() => Promise.resolve(undefined));
    const focus = vi.fn(() => Promise.resolve(undefined));
    const runtime = worker({ windowClients: [{ focus, navigate }] });

    let waited: Promise<unknown> | undefined;
    const notification = { close: vi.fn(), data: { url: '/w/x/y' } };
    runtime.handlers.get('notificationclick')?.({
      notification,
      waitUntil: (promise: Promise<unknown>) => {
        waited = promise;
      },
    });
    await waited;
    expect(notification.close).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith('https://nix.test/w/x/y');
  });

  it('opens a new window when no existing client can be focused', async () => {
    const runtime = worker();
    let waited: Promise<unknown> | undefined;
    const notification = { close: vi.fn(), data: { url: '/w/x/y' } };
    runtime.handlers.get('notificationclick')?.({
      notification,
      waitUntil: (promise: Promise<unknown>) => {
        waited = promise;
      },
    });
    await waited;
    expect(runtime.openWindow).toHaveBeenCalledWith('https://nix.test/w/x/y');
  });

  it('never navigates to a cross-origin notification url', async () => {
    const runtime = worker();
    let waited: Promise<unknown> | undefined;
    const notification = { close: vi.fn(), data: { url: 'https://evil.example/steal' } };
    runtime.handlers.get('notificationclick')?.({
      notification,
      waitUntil: (promise: Promise<unknown>) => {
        waited = promise;
      },
    });
    await waited;
    expect(runtime.openWindow).toHaveBeenCalledWith('https://nix.test/');
  });

  it('re-subscribes with the remembered applicationServerKey and reports the new subscription', async () => {
    const runtime = worker({ storedPushKey: 'AAAA' });
    let waited: Promise<unknown> | undefined;
    runtime.handlers.get('pushsubscriptionchange')?.({
      waitUntil: (promise: Promise<unknown>) => {
        waited = promise;
      },
    });
    await waited;
    expect(runtime.subscribe).toHaveBeenCalledOnce();
    expect(runtime.fetch).toHaveBeenCalledWith(
      '/api/v1/me/push-subscriptions',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
    const body = JSON.parse((runtime.fetch.mock.calls[0]?.[1] as { body: string }).body) as {
      endpoint: string;
    };
    expect(body.endpoint).toBe('https://push.example/x');
  });

  it('does nothing when no applicationServerKey was ever remembered', async () => {
    const runtime = worker();
    let waited: Promise<unknown> | undefined;
    runtime.handlers.get('pushsubscriptionchange')?.({
      waitUntil: (promise: Promise<unknown>) => {
        waited = promise;
      },
    });
    await waited;
    expect(runtime.subscribe).not.toHaveBeenCalled();
    expect(runtime.fetch).not.toHaveBeenCalled();
  });
});
