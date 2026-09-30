// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../../../public/service-worker.js', import.meta.url), 'utf8');

/** A built worker: the same source with the placeholders the build fills in. */
function built(entry: string): string {
  return source
    .replace(
      /const SHELL_ASSETS = \[.*?\];/su,
      `const SHELL_ASSETS = ${JSON.stringify(['/offline.html', '/index.html', entry])};`,
    )
    .replace('const SHELL_ENTRY = null;', `const SHELL_ENTRY = ${JSON.stringify(entry)};`);
}

function worker({
  script = source,
  cached = {},
  network = () => Promise.reject(new Error('offline')),
}: {
  readonly script?: string;
  readonly cached?: Record<string, Response>;
  readonly network?: () => Promise<Response>;
} = {}) {
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const entries = new Map(Object.entries(cached));
  const cache = {
    match: vi.fn((request: string | { url: string }) => {
      const key = typeof request === 'string' ? request : new URL(request.url).pathname;
      return Promise.resolve(entries.get(key)?.clone());
    }),
    put: vi.fn(),
    delete: vi.fn((key: string) => Promise.resolve(entries.delete(key))),
    addAll: vi.fn(() => Promise.resolve(undefined)),
  };
  const fetch = vi.fn(network);
  const skipWaiting = vi.fn();
  runInNewContext(script, {
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
  });
  return { handlers, cache, fetch, skipWaiting };
}

function navigate(runtime: ReturnType<typeof worker>, path: string): Promise<Response> | undefined {
  let response: Promise<Response> | undefined;
  runtime.handlers.get('fetch')?.({
    request: { method: 'GET', url: `https://nix.test${path}`, mode: 'navigate' },
    respondWith: (value: Promise<Response>) => {
      response = value;
    },
  });
  return response;
}

describe('PWA caching boundaries', () => {
  it('never intercepts authenticated API, sign-in, public form or capability requests', () => {
    const runtime = worker({ cached: { '/index.html': new Response('shell') } });
    for (const path of [
      '/auth/session',
      '/api/v1/me',
      '/public/v1/files/x',
      '/collab/documents/x/ws',
      '/internal/jobs',
      '/forms/private-link',
      // The object store serves capability URLs from this origin under a deployment-chosen path.
      '/nix-files/5b8f0c9e-object',
    ]) {
      expect(navigate(runtime, path)).toBeUndefined();
    }
  });

  it('opens an application route from the installed shell without touching the network', async () => {
    const runtime = worker({ cached: { '/index.html': new Response('installed shell') } });
    for (const path of ['/', '/w/workspace?item=x', '/workspaces/archived', '/launch/new']) {
      expect(await (await navigate(runtime, path))?.text()).toBe('installed shell');
    }
    expect(runtime.fetch).not.toHaveBeenCalled();
  });

  it('uses the network, then the offline screen, before a shell is installed', async () => {
    const online = worker({ network: () => Promise.resolve(new Response('from network')) });
    expect(await (await navigate(online, '/w/workspace'))?.text()).toBe('from network');

    const offline = worker({ cached: { '/offline.html': new Response('Offline fallback') } });
    expect(await (await navigate(offline, '/w/workspace'))?.text()).toBe('Offline fallback');
    expect(offline.cache.put).not.toHaveBeenCalled();
  });

  it('installs a shell only when its document names this build entry script', async () => {
    const entry = '/assets/index-abc.js';
    const matching = worker({
      script: built(entry),
      cached: { '/index.html': new Response(`<script src="${entry}"></script>`) },
    });
    let installing: Promise<unknown> | undefined;
    matching.handlers.get('install')?.({
      waitUntil: (value: Promise<unknown>) => {
        installing = value;
      },
    });
    await expect(installing).resolves.toBeUndefined();
    expect(matching.cache.addAll).toHaveBeenCalledWith(['/offline.html', '/index.html', entry]);

    const mismatched = worker({
      script: built(entry),
      cached: { '/index.html': new Response('<script src="/assets/index-other.js"></script>') },
    });
    mismatched.handlers.get('install')?.({
      waitUntil: (value: Promise<unknown>) => {
        installing = value;
      },
    });
    await expect(installing).rejects.toThrow('does not match');
    expect(mismatched.cache.delete).toHaveBeenCalledWith('/index.html');
  });

  it('serves a precached script regardless of the Origin header it is requested with', async () => {
    const runtime = worker({ cached: { '/offline.html': new Response('x') } });
    let response: Promise<Response> | undefined;
    runtime.handlers.get('fetch')?.({
      request: { method: 'GET', url: 'https://nix.test/offline.html', mode: 'cors' },
      respondWith: (value: Promise<Response>) => {
        response = value;
      },
    });
    await response;
    expect(runtime.cache.match).toHaveBeenCalledWith(expect.anything(), { ignoreVary: true });
    expect(runtime.fetch).not.toHaveBeenCalled();
  });

  it('only activates early after an explicit update message', () => {
    const runtime = worker();
    runtime.handlers.get('install')?.({ waitUntil: () => undefined });
    expect(runtime.skipWaiting).not.toHaveBeenCalled();
    runtime.handlers.get('message')?.({ data: { type: 'ACTIVATE_UPDATE' } });
    expect(runtime.skipWaiting).toHaveBeenCalledOnce();
  });
});
