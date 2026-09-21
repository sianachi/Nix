import type { Pool } from 'pg';

import { pruneHistory } from '../db/history.ts';
import { withTenantScope, type ScopedQuery, type TenantScope } from '../db/tenant-scope.ts';
import type { CollabMetrics } from '../metrics.ts';

/**
 * The version-history retention sweep.
 *
 * `docs/plans/version-history.md` describes this as a walk over "documents whose workspace has
 * a non-null `version_retention_days`". In practice the column is `NOT NULL` - every workspace
 * has always had a retention setting, defaulted at creation - so "no retention" is expressed the
 * way the rest of this service already expresses "disabled": zero. `sweepTenant` below skips a
 * workspace at `version_retention_days = 0` and sweeps every other one.
 *
 * **Which tenants to sweep is the harder question, and it is answered outside this module.**
 * Row-level security means a connection scoped to one tenant cannot enumerate any other, and
 * this service holds no role that bypasses it - `migrate-documents.ts` documents that the
 * migrator role is "the one place in the service that reads across tenants", deliberately kept
 * out of the process that also serves traffic. So `startRetentionSweep` is handed the tenants to
 * walk rather than discovering them itself: `apps/collab/src/http/server.ts` reports the scope
 * of every request it authorizes through `ServerDependencies.onTenantSeen`, and `index.ts` wires
 * that into the `activeScopes` this sweep reads on each tick. A tenant with no request against
 * this process since it started is not swept by it - which is the correct amount of harm for a
 * process restart to do: the next request re-registers the tenant, and the next tick after that
 * catches it up. A tenant is never lost permanently, only delayed until it is next seen.
 */

/** One tenant's sweep, and what it found. */
export interface TenantSweepResult {
  readonly workspacesSwept: number;
  readonly documentsSwept: number;
  readonly updatesDeleted: number;
  readonly snapshotsDeleted: number;
  readonly failures: number;
}

/**
 * Prunes every document in every retention-bearing workspace of one tenant.
 *
 * One query joins `content_doc` to `workspace` - the join the design calls for - to find every
 * document whose workspace has a retention window, all under the tenant scope `sql` already
 * carries. A document that fails to prune (a connection blip, a row already gone) is logged
 * through `onDocumentError` and skipped rather than aborting the rest of the tenant's sweep:
 * retention is a background job with another chance next tick, and one document's problem must
 * never hold every other document in the tenant hostage to it.
 */
export async function sweepTenant(
  sql: ScopedQuery,
  tenantId: string,
  now: Date = new Date(),
  onDocumentError?: (docId: string, error: unknown) => void,
): Promise<TenantSweepResult> {
  const { rows } = await sql.query<{
    doc_id: string;
    workspace_id: string;
    version_retention_days: number;
  }>(
    `SELECT d.doc_id, d.workspace_id, w.version_retention_days
     FROM content_doc d
     JOIN workspace w ON w.tenant_id = d.tenant_id AND w.workspace_id = d.workspace_id
     WHERE d.tenant_id = $1 AND w.version_retention_days > 0`,
    [tenantId],
  );

  const workspacesSwept = new Set(rows.map((row) => row.workspace_id)).size;
  let documentsSwept = 0;
  let updatesDeleted = 0;
  let snapshotsDeleted = 0;
  let failures = 0;

  for (const row of rows) {
    try {
      const result = await pruneHistory(sql, tenantId, row.doc_id, row.version_retention_days, now);
      documentsSwept += 1;
      updatesDeleted += result.updatesDeleted;
      snapshotsDeleted += result.snapshotsDeleted;
    } catch (error) {
      failures += 1;
      onDocumentError?.(row.doc_id, error);
    }
  }

  return { workspacesSwept, documentsSwept, updatesDeleted, snapshotsDeleted, failures };
}

export interface RetentionSweepDeps {
  readonly pool: Pool;

  /** Every tenant scope this process has seen a request for, as of this tick. */
  readonly activeScopes: () => readonly TenantScope[];

  /** How often to sweep, in milliseconds. Zero or below disables the sweep entirely. */
  readonly intervalMs: number;

  readonly now?: () => Date;
  readonly log?: (message: string) => void;
  readonly metrics?: CollabMetrics;
}

export interface RetentionSweepHandle {
  /** Stops the timer. Idempotent, and safe to call even when the sweep was disabled. */
  stop(): void;
}

/**
 * Starts the periodic retention sweep, and returns a handle to stop it.
 *
 * Never fatal, at either grain the contract asks for: one document's failure is logged and
 * skipped by {@link sweepTenant}, and one tenant's failure - the transaction itself throwing -
 * is caught here so it costs that tenant's turn and nothing else. A tick that finds no active
 * tenants, or is disabled outright, is silent rather than an error: both are ordinary states,
 * a fresh process and a deployment with retention turned off alike.
 */
export function startRetentionSweep(deps: RetentionSweepDeps): RetentionSweepHandle {
  if (deps.intervalMs <= 0) {
    return { stop: () => undefined };
  }

  const log = deps.log ?? (() => undefined);
  const now = deps.now ?? (() => new Date());

  async function tick(): Promise<void> {
    const scopes = deps.activeScopes();
    let documentsSwept = 0;
    let updatesDeleted = 0;
    let snapshotsDeleted = 0;
    let failures = 0;

    for (const scope of scopes) {
      try {
        const result = await withTenantScope(deps.pool, scope, (sql) =>
          sweepTenant(sql, scope.tenantId, now(), (docId, error) => {
            log(
              `retention sweep: could not prune document ${docId} in tenant ${scope.tenantId}: ` +
                describeError(error),
            );
          }),
        );

        documentsSwept += result.documentsSwept;
        updatesDeleted += result.updatesDeleted;
        snapshotsDeleted += result.snapshotsDeleted;
        failures += result.failures;
      } catch (error) {
        failures += 1;
        log(`retention sweep: tenant ${scope.tenantId} failed: ${describeError(error)}`);
      }
    }

    deps.metrics?.retentionDeletedTotal.inc({ kind: 'update' }, updatesDeleted);
    deps.metrics?.retentionDeletedTotal.inc({ kind: 'snapshot' }, snapshotsDeleted);
    if (failures > 0) {
      deps.metrics?.retentionFailuresTotal.inc(failures);
    }

    log(
      `retention sweep: ${String(scopes.length)} tenant(s), ${String(documentsSwept)} document(s) ` +
        `pruned, ${String(updatesDeleted)} update(s) and ${String(snapshotsDeleted)} snapshot(s) ` +
        `deleted${failures > 0 ? `, ${String(failures)} failure(s)` : ''}.`,
    );
  }

  const timer = setInterval(() => {
    void tick();
  }, deps.intervalMs);
  // A sweep timer must never be the reason the process does not exit - it has a clean `stop()`
  // for the ordinary shutdown path, but nothing else should depend on this firing again.
  timer.unref();

  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
