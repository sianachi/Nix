import { describe, expect, it, vi } from 'vitest';
import { createServerCache, type CacheLoader, type ServerCache } from './cache.js';
import { NixErrorKind } from './errors.js';
import { captureFailure } from './testing/failure.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A cache with a hand-cranked clock so staleness needs no real waiting. */
function cacheWithClock(staleAfterMs = 1_000): {
  cache: ServerCache;
  advance: (ms: number) => void;
} {
  let clock = 0;
  const cache = createServerCache({ now: () => clock, staleAfterMs });
  return {
    cache,
    advance: (ms: number): void => {
      clock += ms;
    },
  };
}

describe('request deduplication', () => {
  it('shares one in-flight load between concurrent readers of the same key', async () => {
    const cache = createServerCache();
    const gate = deferred<string>();
    const load = vi.fn<CacheLoader<string>>(() => gate.promise);

    const readers = [1, 2, 3, 4].map(() => cache.read(['items', 'a'], load));
    gate.resolve('loaded once');
    const results = await Promise.all(readers);

    expect(load).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.data)).toEqual([
      'loaded once',
      'loaded once',
      'loaded once',
      'loaded once',
    ]);
  });

  it('does not share loads across different keys', async () => {
    const cache = createServerCache();
    const load = vi.fn<CacheLoader<string>>(() => Promise.resolve('value'));

    await Promise.all([cache.read(['items', 'a'], load), cache.read(['items', 'b'], load)]);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it('starts a new load once the shared one has settled', async () => {
    const cache = createServerCache({ staleAfterMs: 0 });
    const load = vi.fn<CacheLoader<string>>(() => Promise.resolve('value'));

    await cache.read(['items', 'a'], load);
    const second = await cache.read(['items', 'a'], load, { forceRefresh: true });

    expect(load).toHaveBeenCalledTimes(2);
    expect(second.data).toBe('value');
  });
});

describe('stale while revalidate', () => {
  it('serves a fresh cached value without going back to the loader', async () => {
    const { cache, advance } = cacheWithClock(1_000);
    const load = vi.fn<CacheLoader<number>>(() => Promise.resolve(1));

    await cache.read(['items'], load);
    advance(500);
    const result = await cache.read(['items'], load);

    expect(load).toHaveBeenCalledTimes(1);
    expect(result.servedFromCache).toBe(true);
    expect(result.revalidation).toBeNull();
  });

  it('serves the stale value immediately and refreshes it behind the caller', async () => {
    const { cache, advance } = cacheWithClock(1_000);
    let version = 1;
    const load = vi.fn<CacheLoader<number>>(() => Promise.resolve(version));

    await cache.read(['items'], load);
    advance(1_500);
    version = 2;
    const result = await cache.read(['items'], load);

    expect(result.data).toBe(1);
    expect(result.servedFromCache).toBe(true);
    expect(result.revalidation).not.toBeNull();

    await result.revalidation;

    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.peek<number>(['items'])?.data).toBe(2);
  });

  it('keeps serving the cached value and reports a failed background refresh as telemetry', async () => {
    let clock = 0;
    const onCacheRevalidateError = vi.fn();
    const cache = createServerCache({
      now: () => clock,
      staleAfterMs: 1_000,
      telemetry: { onCacheRevalidateError },
    });
    let attempt = 0;
    const load: CacheLoader<string> = () => {
      attempt += 1;
      return attempt === 1 ? Promise.resolve('cached') : Promise.reject(new Error('core is down'));
    };

    await cache.read(['items'], load);
    clock = 5_000;
    const result = await cache.read(['items'], load);
    await result.revalidation;

    expect(result.data).toBe('cached');
    expect(onCacheRevalidateError).toHaveBeenCalledTimes(1);
    expect(cache.peek<string>(['items'])?.data).toBe('cached');
  });
});

describe('invalidation', () => {
  it('marks an entry stale so the next read refreshes it behind the caller', async () => {
    const cache = createServerCache({ staleAfterMs: 60_000 });
    let version = 1;
    const load: CacheLoader<number> = () => Promise.resolve(version);

    await cache.read(['items', 'a'], load);
    cache.invalidate(['items', 'a']);
    version = 2;
    const result = await cache.read(['items', 'a'], load);
    await result.revalidation;

    expect(result.data).toBe(1);
    expect(cache.peek<number>(['items', 'a'])?.data).toBe(2);
  });

  it('marks every key under a prefix stale and leaves unrelated keys alone', async () => {
    const cache = createServerCache({ staleAfterMs: 60_000 });
    const load: CacheLoader<string> = () => Promise.resolve('value');

    await cache.read(['items', 'a'], load);
    await cache.read(['items', 'b'], load);
    await cache.read(['search', 'q'], load);
    cache.invalidatePrefix(['items']);

    expect(cache.peek(['items', 'a'])?.stale).toBe(true);
    expect(cache.peek(['items', 'b'])?.stale).toBe(true);
    expect(cache.peek(['search', 'q'])?.stale).toBe(false);
  });

  it('drops an evicted entry so the next read has to load it again', async () => {
    const cache = createServerCache();
    const load = vi.fn<CacheLoader<string>>(() => Promise.resolve('value'));

    await cache.read(['items', 'a'], load);
    cache.evict(['items', 'a']);
    await cache.read(['items', 'a'], load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it('tells subscribers which key changed and stops telling them once unsubscribed', async () => {
    const cache = createServerCache();
    const seen: string[][] = [];
    const unsubscribe = cache.subscribe((key) => seen.push([...key]));
    const load: CacheLoader<string> = () => Promise.resolve('value');

    await cache.read(['items', 'a'], load);
    cache.invalidate(['items', 'a']);
    unsubscribe();
    cache.evict(['items', 'a']);

    expect(seen).toEqual([
      ['items', 'a'],
      ['items', 'a'],
    ]);
  });
});

describe('cancellation', () => {
  it('rejects the cancelling reader with a cancellation error', async () => {
    const cache = createServerCache();
    const gate = deferred<string>();
    const controller = new AbortController();

    const pending = captureFailure(
      cache.read(['items', 'a'], () => gate.promise, { signal: controller.signal }),
    );
    controller.abort();
    const error = await pending;

    expect(error.kind).toBe(NixErrorKind.Canceled);
  });

  it('keeps the shared load running for the readers that did not cancel', async () => {
    const cache = createServerCache();
    const gate = deferred<string>();
    let loaderSignal: AbortSignal | undefined;
    const load: CacheLoader<string> = (signal) => {
      loaderSignal = signal;
      return gate.promise;
    };
    const leaving = new AbortController();
    const staying = new AbortController();

    const cancelled = captureFailure(cache.read(['items', 'a'], load, { signal: leaving.signal }));
    const kept = cache.read(['items', 'a'], load, { signal: staying.signal });
    leaving.abort();
    await cancelled;
    gate.resolve('arrived');

    expect((await kept).data).toBe('arrived');
    expect(loaderSignal?.aborted).toBe(false);
  });

  it('aborts the underlying request when the last interested reader cancels', async () => {
    const cache = createServerCache();
    let loaderSignal: AbortSignal | undefined;
    const load: CacheLoader<string> = (signal) => {
      loaderSignal = signal;
      return new Promise<string>(() => undefined);
    };
    const first = new AbortController();
    const second = new AbortController();

    const a = captureFailure(cache.read(['items', 'a'], load, { signal: first.signal }));
    const b = captureFailure(cache.read(['items', 'a'], load, { signal: second.signal }));
    first.abort();
    await a;
    expect(loaderSignal?.aborted).toBe(false);
    second.abort();
    await b;

    expect(loaderSignal?.aborted).toBe(true);
  });
});
