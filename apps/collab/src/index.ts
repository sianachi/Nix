import { Pool } from 'pg';

import { createAuthorizer } from './auth/authorize.ts';
import { createTokenValidator } from './auth/token.ts';
import { readConfig } from './config.ts';
import { createCoreClient } from './core/client.ts';
import { createTouchedNotifier } from './core/touched.ts';
import { createCoreTemplateClient } from './templates/core.ts';
import { createTemplateService } from './templates/service.ts';
import { connectDocumentLocks } from './db/advisory-lock.ts';
import { RateWindow } from './documents/limits.ts';
import { createDocumentRegistry, type DocumentHub } from './documents/registry.ts';
import { createServer } from './http/server.ts';
import { createImportBodyService } from './imports/bodies.ts';
import { createCoreImportClient } from './imports/core.ts';
import { createMetrics } from './metrics.ts';
import { createTemplateImportBodyService } from './template-imports/bodies.ts';
import { createCoreTemplateImportClient } from './template-imports/core.ts';
import { createSessionAuthenticator } from './ws/session-auth.ts';

/**
 * The collaboration service's entry point.
 *
 * Configuration is read and checked first, before a socket is opened: a process that starts
 * happily and refuses every request when somebody finally opens a document is harder to
 * diagnose than one that never starts.
 */
const config = readConfig(process.env);

const pool = new Pool({
  connectionString: config.databaseUrl,
  // Small on purpose. Every request holds a connection for one transaction, and a pool
  // larger than the database's own limit turns a busy moment into a connection storm.
  max: Number(process.env.NIX_COLLAB_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
});

const metrics = createMetrics();

const coreTemplates = createCoreTemplateClient({
  coreBaseUrl: config.coreBaseUrl,
  internalSecret: config.internalSecret,
});

const sessions = createSessionAuthenticator({
  tokens: createTokenValidator({ issuers: config.oidcIssuers, audiences: config.oidcAudiences }),
  authorizer: createAuthorizer({
    coreBaseUrl: config.coreBaseUrl,
    internalSecret: config.internalSecret,
  }),
  templateItems: {
    authorize: (token, templateId, sourceId) =>
      coreTemplates.authorizeTemplateItem(token, templateId, sourceId),
  },
  draftItems: {
    authorize: (token, templateId, operationId, sourceId) =>
      coreTemplates.authorizeDraftItem(token, templateId, operationId, sourceId),
  },
});

// One dedicated connection carries every ownership claim. Losing it means every claim is
// already released on the Postgres side, so the only honest reaction is to drop every
// resident document and let clients re-route to whichever instance owns them next.
let registry: DocumentHub | null = null;
const locks = await connectDocumentLocks({
  databaseUrl: config.databaseUrl,
  onSessionLost: () => {
    void registry?.dropAll();
  },
});

// One rate window for both transports: a principal's budget must not double because they
// opened a socket alongside a polling tab.
const rateWindow = new RateWindow();

// The registry logs through the server's logger, which exists only after createServer;
// the holder breaks the construction cycle without making either depend on the other.
const logHolder: { write: (message: string) => void } = { write: () => undefined };

registry = createDocumentRegistry({
  pool,
  locks,
  rateWindow,
  log: (message) => {
    logHolder.write(message);
  },
  config: {
    flushMs: config.flushMs,
    flushBytes: config.flushBytes,
    snapshotEvery: config.snapshotEvery,
    snapshotIntervalMs: config.snapshotIntervalMs,
    idleEvictMs: config.idleEvictMs,
    maxDocs: config.maxDocs,
    maxResidentBytes: config.maxResidentBytes,
    sweepMs: 60_000,
  },
  metrics,
  onFlushed: createTouchedNotifier({
    coreBaseUrl: config.coreBaseUrl,
    internalSecret: config.internalSecret,
  }),
});

const app = createServer({
  pool,
  sessions,
  core: createCoreClient({ coreBaseUrl: config.coreBaseUrl }),
  internalSecret: config.internalSecret,
  reauthMs: config.reauthSeconds * 1000,
  metrics,
  hub: registry,
  rateWindow,
  templates: createTemplateService({
    pool,
    core: coreTemplates,
    sealItems: (itemIds) => registry.sealItems(itemIds),
    invalidateItems: (itemIds) => registry.invalidateItems(itemIds),
    blockDraftAuthorization: (operationId) => {
      sessions.blockDraftOperation(operationId);
    },
    completeDraftAuthorization: (operationId) => {
      sessions.completeDraftOperation(operationId);
    },
    releaseDraftAuthorization: (operationId) => {
      sessions.releaseDraftOperation(operationId);
    },
  }),
  importBodies: createImportBodyService({
    pool,
    core: createCoreImportClient({
      coreBaseUrl: config.coreBaseUrl,
      internalSecret: config.internalSecret,
    }),
  }),
  templateImportBodies: createTemplateImportBodyService({
    pool,
    core: createCoreTemplateImportClient({
      coreBaseUrl: config.coreBaseUrl,
      internalSecret: config.internalSecret,
    }),
  }),
});

logHolder.write = (message) => {
  app.log.warn(message);
};

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    // Close order is the drain order: stop accepting and tell every socket, drain the
    // registry (final flushes and snapshots), then release the pool and the lock session.
    // Dropping a connection mid-append would roll it back, which is correct but loses an
    // edit somebody had already seen applied locally.
    void app
      .close()
      .then(() => locks.close())
      .then(() => pool.end())
      .then(() => process.exit(0));
  });
}

await app.listen({ port: config.port, host: config.host });
