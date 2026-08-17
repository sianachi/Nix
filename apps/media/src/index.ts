import { createBundleReader } from './collab/bundles.ts';
import { createTemplateImporter } from './collab/templates.ts';
import { readConfig } from './config.ts';
import { createAdmission } from './export/admission.ts';
import { createConverters } from './export/converters.ts';
import { createServer } from './http/server.ts';
import { createMetrics } from './metrics.ts';

/**
 * The media service.
 *
 * **What it does today is convert documents.** The scanning, extraction, thumbnail and quarantine
 * pipeline the development document describes for this service is not here yet - that is MVP-9's
 * files half, and the ClamAV container in the dev stack is already waiting for it. Said plainly so
 * the next person does not read the gap as something forgotten.
 *
 * **What it holds is nothing.** No database credentials - `assertNoDatabaseCredentials` refuses to
 * start if any appear - no object storage, no OIDC configuration, and no authority of its own. It
 * reads documents from the collaboration service with the caller's own token and produces bytes. The
 * isolation is the point: this is the process that will parse untrusted files, and the less it can
 * reach when that day comes, the less a parser bug is worth.
 */

const config = readConfig(process.env);
const metrics = createMetrics();

const app = createServer({
  bundles: createBundleReader({
    collabBaseUrl: config.collabBaseUrl,
    internalSecret: config.internalSecret,
    maxBytes: config.maxBundleBytes,
  }),
  converters: createConverters(),
  admission: createAdmission(config.maxConcurrentExports),
  templateAdmission: createAdmission(config.maxConcurrentTemplateParses),
  jobTimeoutMs: config.jobTimeoutMs,
  maxOutputBytes: config.maxOutputBytes,
  templates: createTemplateImporter({
    collabBaseUrl: config.collabBaseUrl,
    internalSecret: config.internalSecret,
  }),
  metrics,
  logLevel: config.logLevel,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    // Fastify's close waits for in-flight responses, which for this service means letting the
    // conversions that already started finish writing rather than truncating somebody's download.
    // There is no pool and no lock session to release, so the drain ends there.
    void app.close().then(() => {
      process.exit(0);
    });
  });
}

await app.listen({ port: config.port, host: config.host });
