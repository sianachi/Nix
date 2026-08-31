import { createBundleReader } from './collab/bundles.ts';
import { createTemplateImporter } from './collab/templates.ts';
import { readConfig } from './config.ts';
import { createAdmission } from './export/admission.ts';
import { createConverters } from './export/converters.ts';
import { createServer } from './http/server.ts';
import { createMetrics } from './metrics.ts';
import { createWorkerJobs } from './workers/jobs.ts';
import { WorkerObjectStore } from './workers/storage.ts';

/**
 * The media service.
 *
 * **What it does today is convert documents.** The scanning, extraction, thumbnail and quarantine
 * pipeline the development document describes for this service is not here yet - that is MVP-9's
 * files half, and the ClamAV container in the dev stack is already waiting for it. Said plainly so
 * the next person does not read the gap as something forgotten.
 *
 * **What it never holds is database or authorization authority.** `assertNoDatabaseCredentials`
 * refuses database credentials; object storage credentials are scoped to transient worker objects.
 * It forwards the caller's token to Collaboration/Core, which remain the permission authorities.
 */

const config = readConfig(process.env);

const workerServices =
  config.goExportEnabled || config.goImportEnabled
    ? {
        jobs: createWorkerJobs({
          coreBaseUrl: config.coreBaseUrl,
          internalSecret: config.internalSecret,
        }),
        storage: new WorkerObjectStore({
          endpoint: config.objectStoreEndpoint,
          region: config.objectStoreRegion,
          bucket: config.objectStoreBucket,
          accessKey: config.objectStoreAccessKey,
          secretKey: config.objectStoreSecretKey,
        }),
      }
    : undefined;
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
  workerImports: config.goImportEnabled ? workerServices : undefined,
  workerExports: config.goExportEnabled ? workerServices : undefined,
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
