import type { Pool, PoolClient } from 'pg';

/**
 * The tenant a unit of work runs as.
 *
 * Both fields are published to Postgres as transaction-local settings that the row-level
 * security policies read. There is no anonymous path, and exactly one unscoped one: the
 * document schema migrator (`src/migrate-documents.ts`), a separate job that connects as the
 * migrator role because a corpus-wide walk cannot be expressed inside a single tenant. It is
 * the only exception and it argues for itself where it is defined.
 */
export interface TenantScope {
  readonly tenantId: string;
  readonly principalId: string;
}

/**
 * Every query this service runs, and - the migrator job aside, see {@link TenantScope} - the
 * only way it may run one.
 *
 * Deliberately narrower than a `PoolClient`: it exposes `query` and nothing else, so
 * nothing downstream can begin a transaction of its own, take the connection out of the
 * scope, or return it to the pool early.
 */
export interface ScopedQuery {
  // The row type is named by the caller so query results are typed at the call site, which is
  // the ergonomic point of this shape - a cast there would be less safe, not more.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  query<TRow extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: TRow[]; rowCount: number | null }>;
}

/**
 * Thrown when the tenant scope is missing or malformed.
 *
 * A separate type because the correct response to it is never "carry on with no tenant" -
 * which, against policies that read a setting, means either nothing or, on a table someone
 * forgot to protect, everything.
 */
export class TenantScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantScopeError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `work` inside one transaction, with the tenant scope published for its duration.
 *
 * **This is the single riskiest mechanism in the service, and it is the only entry point
 * to the database.** The .NET side gets the same guarantee from an EF interceptor plus a
 * guard that refuses SQL outside a transaction; Node has neither, so the discipline is
 * enforced here by construction:
 *
 * - `SET LOCAL`, never `SET`. A plain `SET` outlives the transaction and rides the pooled
 *   connection to whoever leases it next, which is a cross-tenant read waiting to happen.
 *   `SET LOCAL` is reverted by `COMMIT` and by `ROLLBACK` alike, so no path leaks it.
 * - The scope is published *inside* the transaction, before any statement of `work` runs.
 *   Published before `BEGIN`, `SET LOCAL` would apply to a transaction that does not exist
 *   yet and be discarded.
 * - The identifiers are checked against the UUID shape before they are interpolated.
 *   `SET LOCAL` cannot take a bind parameter - Postgres parses it before parameters are
 *   substituted - so this is the one place in the service where a value reaches SQL as
 *   text, and the check is what makes that safe rather than merely conventional.
 * - Callers receive a {@link ScopedQuery}, not the client. They cannot commit, roll back,
 *   release, or start a nested transaction; the shape of the API is the guard.
 *
 * @param pool the connection pool
 * @param scope whose tenant the work runs as
 * @param work the unit of work; its return value is the result
 */
export async function withTenantScope<TResult>(
  pool: Pool,
  scope: TenantScope,
  work: (sql: ScopedQuery) => Promise<TResult>,
): Promise<TResult> {
  assertUuid(scope.tenantId, 'tenantId');
  assertUuid(scope.principalId, 'principalId');

  const client: PoolClient = await pool.connect();

  try {
    await client.query('BEGIN');

    // Interpolated, and safe only because of the assertions above. Kept to one statement
    // so there is exactly one place to audit.
    await client.query(
      `SET LOCAL nix.tenant_id = '${scope.tenantId}'; SET LOCAL nix.principal_id = '${scope.principalId}'`,
    );

    const result = await work({
      query: (text, values) =>
        client.query(text, values === undefined ? undefined : [...values]) as never,
    });

    await client.query('COMMIT');
    return result;
  } catch (error) {
    // Rollback failures are swallowed on purpose: the original error is the one worth
    // reporting, and a connection that cannot roll back is destroyed on release anyway.
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function assertUuid(value: string, field: string): void {
  if (!UUID.test(value)) {
    throw new TenantScopeError(
      `The ${field} of a tenant scope must be a UUID; refusing to publish '${value}' as a ` +
        'session setting. This value reaches SQL as text because SET LOCAL cannot be ' +
        'parameterised.',
    );
  }
}
