import { describe, expect, it } from 'vitest';

import { TenantScopeError, withTenantScope } from './tenant-scope.ts';

/**
 * The tenant scope, checked without a database.
 *
 * These assert the mechanism rather than its effect: that the statement issued is `SET
 * LOCAL` and not `SET`, that it is issued inside the transaction, and that the connection
 * always goes back to the pool. The effect - that another tenant's rows are invisible - is
 * asserted against real Postgres in the companion suite, because a policy that is not there
 * cannot be caught by a fake.
 */

interface Recorded {
  readonly statements: string[];
  readonly released: number;
}

function fakePool(behaviour: { failOn?: RegExp } = {}): { pool: never; log: Recorded } {
  const statements: string[] = [];
  const log = { statements, released: 0 };

  const client = {
    query(text: string) {
      statements.push(text);
      if (behaviour.failOn?.test(text) === true) {
        return Promise.reject(new Error(`refused: ${text}`));
      }

      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    release() {
      log.released += 1;
    },
  };

  return { pool: { connect: () => Promise.resolve(client) } as never, log };
}

const scope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  principalId: '1b1b1b1b-1111-4111-8111-1b1b1b1b1b1b',
};

describe('the tenant scope', () => {
  it('publishes the tenant with SET LOCAL and never with a bare SET', async () => {
    const { pool, log } = fakePool();

    await withTenantScope(pool, scope, async (sql) => {
      await sql.query('SELECT 1');
    });

    const settings = log.statements.filter((statement) => statement.includes('nix.tenant_id'));
    expect(settings).toHaveLength(1);

    // The whole isolation story rests on this word. A plain SET outlives the transaction and
    // rides the pooled connection to whoever leases it next.
    expect(settings[0]).toContain('SET LOCAL nix.tenant_id');
    expect(settings[0]).not.toMatch(/(?<!LOCAL )SET nix\./);
  });

  it('publishes the scope after BEGIN and before any of the caller work', async () => {
    const { pool, log } = fakePool();

    await withTenantScope(pool, scope, async (sql) => {
      await sql.query('SELECT 1');
    });

    // Published before BEGIN, SET LOCAL would apply to a transaction that does not exist and
    // be discarded - leaving the caller's statements running with no tenant at all.
    expect(log.statements[0]).toBe('BEGIN');
    expect(log.statements[1]).toContain('SET LOCAL');
    expect(log.statements[2]).toBe('SELECT 1');
    expect(log.statements[3]).toBe('COMMIT');
  });

  it('publishes the principal as well as the tenant', async () => {
    const { pool, log } = fakePool();

    await withTenantScope(pool, scope, () => Promise.resolve(undefined));

    expect(log.statements[1]).toContain(`SET LOCAL nix.principal_id = '${scope.principalId}'`);
  });

  it('rolls back and returns the connection when the work throws', async () => {
    const { pool, log } = fakePool();

    await expect(
      withTenantScope(pool, scope, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');

    expect(log.statements).toContain('ROLLBACK');
    expect(log.statements).not.toContain('COMMIT');
    expect(log.released).toBe(1);
  });

  it('returns the connection even when the rollback itself fails', async () => {
    const { pool, log } = fakePool({ failOn: /ROLLBACK/ });

    await expect(
      withTenantScope(pool, scope, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');

    // A connection that leaked here would be leaked for the process's lifetime, and the
    // symptom would be the pool exhausting itself hours later under load.
    expect(log.released).toBe(1);
  });

  it.each([
    ['not a uuid', 'nonsense'],
    [
      'a uuid with an injection appended',
      "11111111-1111-4111-8111-111111111111'; DROP TABLE item--",
    ],
    ['empty', ''],
  ])('refuses a tenant that is %s', async (_name, tenantId) => {
    const { pool, log } = fakePool();

    // SET LOCAL cannot take a bind parameter - Postgres parses it before parameters are
    // substituted - so this value reaches SQL as text, and this check is what makes that safe.
    await expect(
      withTenantScope(pool, { ...scope, tenantId }, () => Promise.resolve(undefined)),
    ).rejects.toBeInstanceOf(TenantScopeError);

    // Refused before a connection was even taken.
    expect(log.statements).toEqual([]);
  });

  it('refuses a principal that is not a uuid', async () => {
    const { pool } = fakePool();

    await expect(
      withTenantScope(pool, { ...scope, principalId: 'someone' }, () => Promise.resolve(undefined)),
    ).rejects.toBeInstanceOf(TenantScopeError);
  });

  it('hands the caller a query function and nothing else', async () => {
    const { pool } = fakePool();

    await withTenantScope(pool, scope, (sql) => {
      // No commit, no rollback, no release, no nested transaction. The shape of the API is
      // the guard: there is nothing to reach for.
      expect(Object.keys(sql)).toEqual(['query']);
      return Promise.resolve(undefined);
    });
  });
});
