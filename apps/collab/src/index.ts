import { Pool } from 'pg';

import { createAuthorizer } from './auth/authorize.ts';
import { createTokenValidator } from './auth/token.ts';
import { readConfig } from './config.ts';
import { createServer } from './http/server.ts';

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

const app = createServer({
  pool,
  tokens: createTokenValidator({ issuer: config.oidcIssuer, audiences: config.oidcAudiences }),
  authorizer: createAuthorizer({ coreBaseUrl: config.coreBaseUrl }),
  snapshotEvery: config.snapshotEvery,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    // In-flight transactions finish; the pool closes after the server stops accepting.
    // Dropping a connection mid-append would roll it back, which is correct but loses an
    // edit somebody had already seen applied locally.
    void app
      .close()
      .then(() => pool.end())
      .then(() => process.exit(0));
  });
}

await app.listen({ port: config.port, host: config.host });
