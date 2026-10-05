import { describe, expect, it } from 'vitest';

import { LIMITS, RateWindow, rejection } from './limits.ts';

describe('backpressure', () => {
  it('allows a principal up to the limit and refuses the one after', () => {
    const now = 0;
    const window = new RateWindow(() => now);

    for (let index = 0; index < LIMITS.updatesPerWindow; index += 1) {
      expect(window.exceeded('principal', 'doc')).toBe(false);
    }

    expect(window.exceeded('principal', 'doc')).toBe(true);
  });

  it('counts each document separately', () => {
    const window = new RateWindow(() => 0);

    for (let index = 0; index < LIMITS.updatesPerWindow; index += 1) {
      window.exceeded('principal', 'first');
    }

    // Hammering one document must not lock somebody out of every other one.
    expect(window.exceeded('principal', 'second')).toBe(false);
  });

  it('counts each principal separately', () => {
    const window = new RateWindow(() => 0);

    for (let index = 0; index < LIMITS.updatesPerWindow + 1; index += 1) {
      window.exceeded('noisy', 'doc');
    }

    expect(window.exceeded('quiet', 'doc')).toBe(false);
  });

  it('forgives once the window has passed', () => {
    let now = 0;
    const window = new RateWindow(() => now);

    for (let index = 0; index < LIMITS.updatesPerWindow + 1; index += 1) {
      window.exceeded('principal', 'doc');
    }

    now += LIMITS.windowMs;

    expect(window.exceeded('principal', 'doc')).toBe(false);
  });

  it('drops expired windows so the map does not grow forever', () => {
    let now = 0;
    const window = new RateWindow(() => now);

    for (let index = 0; index < 50; index += 1) {
      window.exceeded(`principal-${String(index)}`, 'doc');
    }

    expect(window.size).toBe(50);

    now += LIMITS.windowMs;
    window.sweep();

    // Without the sweep this grows by one entry per principal per document for the process's
    // lifetime - a slow leak, which is the kind that reaches production.
    expect(window.size).toBe(0);
  });
});

describe('rejections', () => {
  it.each([
    ['update_too_large', 413],
    ['document_too_many_nodes', 413],
    ['document_too_large', 413],
    ['rate_limited', 429],
    ['schema_version_mismatch', 409],
    ['update_unreadable', 422],
    ['document_does_not_parse', 422],
  ] as const)('maps %s onto %i', (code, status) => {
    expect(rejection(code, 'because').status).toBe(status);
  });

  it('keeps the update ceiling in step with the column constraint', () => {
    // The CHECK on content_update.update_bytes is 1 MiB. If these drift, an update passes
    // here and fails at the database, turning a 413 with a code a client can act on into a
    // 500 nobody can.
    expect(LIMITS.updateBytes).toBe(1024 * 1024);
    expect(LIMITS.snapshotBytes).toBe(16 * 1024 * 1024);
  });
});
