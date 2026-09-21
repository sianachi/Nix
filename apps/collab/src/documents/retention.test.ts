import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { startRetentionSweep } from './retention.ts';

/**
 * The retention sweep's scheduling, with no database behind it.
 *
 * What actually prunes a document is `sweepTenant`, proven against real Postgres in
 * `retention.db.test.ts`. What belongs here is everything around it that does not need a
 * database at all: a disabled sweep must never open a connection, and stopping one must be
 * safe to call more than once.
 */

const refusingPool = new Proxy({} as Pool, {
  get() {
    throw new Error('The sweep reached the database, which a disabled sweep never should.');
  },
});

describe('startRetentionSweep', () => {
  it('never touches the pool when the interval is zero', () => {
    const handle = startRetentionSweep({
      pool: refusingPool,
      activeScopes: () => {
        throw new Error('A disabled sweep must never ask which tenants are active.');
      },
      intervalMs: 0,
    });

    // Nothing has thrown by the time this line runs, which is the claim: constructing a
    // disabled sweep does no work at all, immediate or scheduled.
    expect(() => {
      handle.stop();
    }).not.toThrow();
  });

  it('never touches the pool for a negative interval either', () => {
    const handle = startRetentionSweep({
      pool: refusingPool,
      activeScopes: () => [],
      intervalMs: -1,
    });

    expect(() => {
      handle.stop();
    }).not.toThrow();
  });

  it('stop is idempotent', () => {
    const handle = startRetentionSweep({
      pool: refusingPool,
      activeScopes: () => [],
      intervalMs: 0,
    });

    handle.stop();
    expect(() => {
      handle.stop();
    }).not.toThrow();
  });
});
