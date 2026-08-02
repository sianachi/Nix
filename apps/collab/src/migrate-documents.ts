import { realpathSync } from 'node:fs';

import { SCHEMA_VERSION } from '@nix/editor-schema';
import { Pool, type PoolClient } from 'pg';

import type { ContentDocRow } from './db/documents.ts';
import type { ScopedQuery } from './db/tenant-scope.ts';
import {
  MigrationTally,
  migrateDocument,
  type DocumentOutcome,
  type MigrationReport,
} from './documents/schema-migrations.ts';

/**
 * Raises every stored document's schema pin to what this build speaks.
 *
 * **A job, not a startup step, and a different executable from the service.** It runs beside
 * `Nix.Migrator` at deploy: the schema migration moves the tables, this moves the documents,
 * and neither belongs in a process that is also serving traffic. Until it has run, documents
 * sit at their old pin and the service holds every write to the old node set - which is
 * correct and uneventful, and is why this can run after the deploy rather than during it.
 *
 * **This is the one place in the service that reads across tenants, and it does so on
 * purpose.** Row-level security is `FORCE`d on the content tables, so a per-tenant scope
 * cannot enumerate the corpus and neither can the collaboration role. The migrator role is
 * the only one permitted `BYPASSRLS` - the seed says so and asserts it - so this connects as
 * that role and is refused outright if it finds itself as anything else. Every statement
 * still carries `tenant_id` explicitly, exactly as the scoped path does, so the queries are
 * correct on their own terms rather than merely because a policy is switched off.
 */

/** The environment variable naming the migrator role's connection string. */
const CONNECTION_VARIABLE = 'NIX_COLLAB_MIGRATOR_CONNECTION_STRING';

/** How many documents one page of work reads. Bounded so a large corpus is not one array. */
const PAGE_SIZE = 200;

interface DocumentToMigrate extends ContentDocRow {
  readonly tenant_id: string;
  readonly item_type: string;
}

/**
 * Refuses to run as a role that cannot see the corpus.
 *
 * Without this the job would connect happily as `nix_collab`, read nothing at all because
 * every row is filtered by a policy it cannot satisfy, and report a clean run over an
 * untouched database. A migration that silently does nothing and says it succeeded is worse
 * than one that fails, because the failure it causes surfaces somewhere else entirely.
 */
async function assertCanSeeEveryTenant(client: PoolClient): Promise<void> {
  // Superuser as well as BYPASSRLS: a superuser is exempt from every policy whatever
  // `rolbypassrls` happens to say, and the compose stack's own administrative role is one.
  // Checking only the flag would refuse a connection that can in fact see everything.
  const { rows } = await client.query<{ role: string; bypasses: boolean }>(
    `SELECT current_user AS role,
            coalesce(
              (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user),
              false)
              AS bypasses`,
  );

  const status = rows[0];
  if (status === undefined) {
    throw new Error('Could not determine which role this connection is using.');
  }

  if (!status.bypasses) {
    throw new Error(
      `Refusing to run: connected as '${status.role}', which is subject to row-level ` +
        'security and can therefore see no documents at all outside a tenant scope. Set ' +
        `${CONNECTION_VARIABLE} to the migrator role's connection string.`,
    );
  }
}

/**
 * Reads one page of documents needing work, oldest pin first.
 *
 * Joined to `item` for the body kind, because the pin column is shared by prose, canvases and
 * sheets and each is validated by different rules. A document whose item has since been
 * hard-deleted has no kind to validate against and is skipped rather than guessed at - an
 * inner join, deliberately.
 *
 * Keyset paged on `(tenant_id, doc_id)` rather than by offset: rows are being updated as the
 * run proceeds, and an offset walk over a moving result set skips rows.
 */
async function readPage(
  client: PoolClient,
  target: number,
  after: { tenantId: string; docId: string } | null,
  onlyTenantIds: readonly string[] | null,
): Promise<DocumentToMigrate[]> {
  const { rows } = await client.query<DocumentToMigrate>(
    `SELECT d.doc_id, d.tenant_id, d.item_id, d.workspace_id, d.schema_version, d.head_seq,
            i.type AS item_type
     FROM content_doc AS d
     JOIN item AS i ON i.id = d.item_id AND i.tenant_id = d.tenant_id
     WHERE d.schema_version < $1
       AND ($2::uuid IS NULL OR (d.tenant_id, d.doc_id) > ($2::uuid, $3::uuid))
       AND ($5::uuid[] IS NULL OR d.tenant_id = ANY($5::uuid[]))
     ORDER BY d.tenant_id, d.doc_id
     LIMIT $4`,
    [target, after?.tenantId ?? null, after?.docId ?? null, PAGE_SIZE, onlyTenantIds],
  );

  return rows;
}

/**
 * Wraps a raw client as a {@link ScopedQuery}.
 *
 * The shape the document code expects, without the tenant scope - which this job cannot use,
 * because a scope names one tenant and the corpus spans all of them. Narrow on purpose all the
 * same: the callers still cannot commit, roll back or release.
 */
function unscoped(client: PoolClient): ScopedQuery {
  return {
    query: (text, values) =>
      client.query(text, values === undefined ? undefined : [...values]) as never,
  };
}

/** What one run is asked to do. */
export interface MigrationRun {
  /** The version to raise pins to. Defaults to what this build speaks. */
  readonly target?: number;

  /**
   * Migrate only these tenants' documents.
   *
   * For a canary: raise one tenant's pins, watch, then run unfiltered. Absent means the whole
   * corpus, which is the normal deploy-time invocation - the filter is deliberately not
   * exposed on the command line, so nobody reaches for it by accident and leaves the rest of
   * the corpus behind believing the migration ran.
   */
  readonly onlyTenantIds?: readonly string[];

  /** Where progress and anything left behind are reported. Defaults to silence, not stdout. */
  readonly log?: (message: string) => void;
}

/**
 * Migrates every document the filter admits, and reports what happened.
 *
 * **No transaction per document, because there is never more than one statement.** A step
 * declaring a content rewrite is refused outright by `migrateDocument`, so the write is always
 * the single `UPDATE` that raises the pin - which is already atomic. Wrapping it would turn
 * one round trip into three, and would hold a transaction open across the update-log replay
 * that precedes it, pinning the cluster's vacuum horizon once per document for the length of
 * the corpus. The transaction comes back the day a rewrite does, and it belongs around the
 * append and the pin write together.
 */
export async function migrateAllDocuments(
  pool: Pool,
  run: MigrationRun = {},
): Promise<MigrationReport> {
  const target = run.target ?? SCHEMA_VERSION;
  const log = run.log ?? ((): void => undefined);
  const onlyTenantIds = run.onlyTenantIds ?? null;

  const client = await pool.connect();
  const tally = new MigrationTally();
  let seen = 0;

  try {
    await assertCanSeeEveryTenant(client);

    let after: { tenantId: string; docId: string } | null = null;

    for (;;) {
      const page: DocumentToMigrate[] = await readPage(client, target, after, onlyTenantIds);
      if (page.length === 0) {
        break;
      }

      for (const doc of page) {
        let outcome: DocumentOutcome;
        try {
          outcome = await migrateDocument(
            unscoped(client),
            doc.tenant_id,
            doc,
            doc.item_type,
            target,
          );
        } catch (cause) {
          throw new Error(`Failed while migrating document ${doc.doc_id} (item ${doc.item_id}).`, {
            cause,
          });
        }

        tally.add(outcome);

        if (outcome.status === 'unparseable') {
          log(
            `Left document ${doc.doc_id} (item ${doc.item_id}) at schema version ` +
              `${String(doc.schema_version)}: it does not parse, so raising its pin would ` +
              'move it from openable-by-an-old-build to broken everywhere.',
          );
        }

        if (outcome.status === 'aboveTarget') {
          log(
            `Left document ${doc.doc_id} (item ${doc.item_id}) at schema version ` +
              `${String(doc.schema_version)}: it needs version ${String(outcome.needs)} and ` +
              `this run targets ${String(outcome.target)}. The document is fine.`,
          );
        }
      }

      seen += page.length;
      // Progress per page, not only at the end. A corpus walk that prints nothing for several
      // minutes is indistinguishable from a hung one, and the first instinct is to kill it.
      log(`Migrated ${String(tally.report().migrated)} of ${String(seen)} documents seen.`);

      const last = page[page.length - 1];
      if (last === undefined) {
        break;
      }
      after = { tenantId: last.tenant_id, docId: last.doc_id };
    }
  } finally {
    client.release();
  }

  return tally.report();
}

/**
 * The job's entry point.
 *
 * Exits non-zero when any document was left behind, so a deploy step notices. An unparseable
 * document is not a reason to abandon the run - the other several thousand should still be
 * migrated - but it is absolutely a reason to fail the step that ran it.
 */
async function main(): Promise<void> {
  const connectionString = process.env[CONNECTION_VARIABLE];
  if (connectionString === undefined || connectionString.length === 0) {
    throw new Error(
      `${CONNECTION_VARIABLE} is not set. It must name the migrator role, which is the only ` +
        'role permitted to read across tenants. NIX_COLLAB_DATABASE_URL is deliberately not ' +
        'accepted as a fallback: that role would read nothing and report success.',
    );
  }

  const pool = new Pool({ connectionString, max: 1 });

  try {
    const report = await migrateAllDocuments(pool, {
      target: SCHEMA_VERSION,
      log: (message) => {
        process.stderr.write(`${message}\n`);
      },
    });

    process.stdout.write(
      `Document schema migration to version ${String(SCHEMA_VERSION)}: ` +
        `${String(report.migrated)} migrated, ` +
        `${String(report.unchanged)} already raised by another run, ` +
        `${String(report.aboveTarget)} needing a newer build, ` +
        `${String(report.unparseable.length)} left behind because they do not open.\n`,
    );

    if (report.unparseable.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

// Only when run directly, so the exported runner stays importable by tests without dragging
// in the connection string requirement or the exit code. Both sides are resolved through
// realpath: `import.meta.filename` already is, and comparing it against a raw argv would make a
// symlinked invocation skip `main` and exit zero - a deploy step reporting a migration it never
// ran, which is the failure this file goes to some length elsewhere to prevent.
const invokedAs = process.argv[1];
if (invokedAs !== undefined && realpathSync(invokedAs) === import.meta.filename) {
  await main();
}
