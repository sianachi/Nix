import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';

import { PRINT_PALETTE } from '@nix/design-tokens/print';
import {
  ArchiveReadError,
  TEMPLATE_ARCHIVE_LIMITS,
  TEMPLATE_IMPORT_REQUEST_BYTES,
  exportFileName,
  readArchive,
  validateTemplateArchive,
  type ConverterRegistry,
  type ReadArchiveResult,
} from '@nix/export';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { BundleRefusal, type BundleReader } from '../collab/bundles.ts';
import {
  parseManagedFinalizeRequest,
  TemplateImportRefusal,
  type ImportedTemplateRequest,
  type TemplateImporter,
} from '../collab/templates.ts';
import type { Admission } from '../export/admission.ts';
import { rasterise } from '../export/rasterise.ts';
import { boundedBytes } from '../export/run.ts';
import type { MediaMetrics } from '../metrics.ts';
import { WorkerJobRefusal, type WorkerJobs } from '../workers/jobs.ts';
import type { WorkerStorage } from '../workers/storage.ts';
import { bearer, isUuid, problem } from './problem.ts';

/**
 * The media service's HTTP surface.
 *
 * **This service decides no permissions and validates no tokens.** It shape-checks the bearer it was
 * given, forwards it to the collaboration service, and believes the answer - which keeps one
 * authorization code path in the system. Validating the JWT here would save a round trip and cost a
 * second JWKS cache, a second issuer list, and a second place for the multi-issuer configuration to
 * drift; worse, it would *look* like an authorization decision, and a service that appears to decide
 * is one somebody eventually extends to actually decide.
 *
 * The collaboration service's refusals are forwarded verbatim, status and sentence both. It made the
 * decision, so it owns the wording, and the web client already reads problem details from either.
 */

export interface ServerDependencies {
  readonly bundles: BundleReader;
  readonly converters: ConverterRegistry;
  readonly admission: Admission;
  readonly templateAdmission?: Admission | undefined;
  readonly jobTimeoutMs: number;
  readonly maxOutputBytes: number;
  readonly metrics?: MediaMetrics | undefined;
  readonly logLevel?: string | undefined;
  readonly templates?: TemplateImporter | undefined;
  readonly templateReadTimeoutMs?: number | undefined;
  readonly workerImports?:
    { readonly jobs: WorkerJobs; readonly storage: WorkerStorage } | undefined;
  readonly workerExports?:
    { readonly jobs: WorkerJobs; readonly storage: WorkerStorage } | undefined;

  /** Injected so a produced file's metadata does not depend on the wall clock in a test. */
  readonly now?: (() => Date) | undefined;
}

export function createServer(deps: ServerDependencies): FastifyInstance {
  const app = Fastify({
    logger: process.env.NODE_ENV === 'test' ? false : { level: deps.logLevel ?? 'info' },
  });

  // The parser hands the stream through untouched. `readArchive` applies compressed and expanded
  // limits while consuming it; buffering here would defeat the zip-bomb boundary Media owns.
  app.addContentTypeParser(
    ['application/zip', 'application/x-nix-template', 'application/octet-stream'],
    (_request, payload, done) => {
      done(null, payload);
    },
  );

  app.get('/healthz', () => ({
    status: 'healthy',
    // What this build can actually produce, read from the registry rather than restated - a health
    // check that lists a format the registry does not hold is worse than one that lists nothing.
    formats: deps.converters.formats(),
  }));

  if (deps.metrics !== undefined) {
    const metrics = deps.metrics;
    app.get('/metrics', async (_request: FastifyRequest, reply: FastifyReply) => {
      return await reply.type(metrics.registry.contentType).send(await metrics.registry.metrics());
    });
  }

  if (deps.templates !== undefined) {
    const templates = deps.templates;

    app.post(
      '/templates/preview',
      { bodyLimit: TEMPLATE_ARCHIVE_LIMITS.maxInputBytes },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const token = bearer(request.headers.authorization);
        if (token === null) {
          return problem(reply, 401, 'unauthenticated', 'A bearer token is required.');
        }
        const query = request.query as { workspaceId?: string };
        if (query.workspaceId === undefined || !isUuid(query.workspaceId)) {
          return problem(
            reply,
            400,
            'template.workspace_invalid',
            'A workspaceId UUID is required.',
          );
        }
        const work = templateWork(request, deps.templateReadTimeoutMs ?? 30_000);
        let release: (() => void) | null = null;
        try {
          await requireTemplateAdmission(templates, token, query.workspaceId, false, work.signal);
          release = (deps.templateAdmission ?? deps.admission).enter();
          if (release === null) return await templateBusy(reply);
          const upload = await readTemplateUploadThroughWorker(
            request.body,
            query.workspaceId,
            token,
            deps,
            work.signal,
          );
          const profile = validateTemplateArchive(upload.archive);
          const validation = templateRequest(upload, profile, query.workspaceId, 'user');
          await templates.validateTemplate(token, validation, work.signal);
          return await reply.send({
            profile,
            digest: upload.digest,
            rootItemType:
              upload.archive.bundles.find((bundle) => bundle.id === upload.archive.manifest.root)
                ?.type ?? 'note',
            itemCount: upload.archive.bundles.length,
            bodyCount: upload.archive.bundles.filter((bundle) => bundle.body !== null).length,
            viewCount: upload.archive.bundles.reduce(
              (count, bundle) => count + (bundle.views?.views.length ?? 0),
              0,
            ),
          });
        } catch (error) {
          return await templateProblem(reply, error, work.signal);
        } finally {
          release?.();
          work.dispose();
        }
      },
    );

    app.post(
      '/templates/commit',
      { bodyLimit: TEMPLATE_ARCHIVE_LIMITS.maxInputBytes },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const token = bearer(request.headers.authorization);
        if (token === null) {
          return problem(reply, 401, 'unauthenticated', 'A bearer token is required.');
        }
        const query = request.query as {
          workspaceId?: string;
        };
        if (query.workspaceId === undefined || !isUuid(query.workspaceId)) {
          return problem(
            reply,
            400,
            'template.workspace_invalid',
            'A workspaceId UUID is required.',
          );
        }
        const work = templateWork(request, deps.templateReadTimeoutMs ?? 30_000);
        let release: (() => void) | null = null;
        try {
          await requireTemplateAdmission(templates, token, query.workspaceId, false, work.signal);
          release = (deps.templateAdmission ?? deps.admission).enter();
          if (release === null) return await templateBusy(reply);
          const upload = await readTemplateUploadThroughWorker(
            request.body,
            query.workspaceId,
            token,
            deps,
            work.signal,
          );
          const profile = validateTemplateArchive(upload.archive);
          const expectedDigest = header(request, 'x-nix-template-digest');
          if (!sameDigest(expectedDigest, upload.digest)) {
            return await problem(
              reply,
              409,
              'template.file_changed',
              'The selected file changed after preview. Preview it again before importing.',
            );
          }
          const imported = await templates.importTemplate(
            token,
            templateRequest(
              upload,
              profile,
              query.workspaceId,
              'user',
              undefined,
              header(request, 'x-idempotency-key') ?? `template-user:${randomUUID()}`,
            ),
            work.signal,
          );
          return await reply.code(201).send(imported);
        } catch (error) {
          return await templateProblem(reply, error, work.signal);
        } finally {
          release?.();
          work.dispose();
        }
      },
    );

    app.post(
      '/templates/managed/stage',
      { bodyLimit: TEMPLATE_ARCHIVE_LIMITS.maxInputBytes },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const token = bearer(request.headers.authorization);
        const query = request.query as { workspaceId?: string; managedSource?: string };
        if (token === null) {
          return problem(reply, 401, 'unauthenticated', 'A bearer token is required.');
        }
        if (
          query.workspaceId === undefined ||
          !isUuid(query.workspaceId) ||
          query.managedSource === undefined ||
          query.managedSource.length > 500
        ) {
          return problem(
            reply,
            400,
            'template.managed_source_invalid',
            'A workspaceId and bounded managedSource are required.',
          );
        }
        const work = templateWork(request, deps.templateReadTimeoutMs ?? 30_000);
        let release: (() => void) | null = null;
        try {
          await requireTemplateAdmission(templates, token, query.workspaceId, true, work.signal);
          release = (deps.templateAdmission ?? deps.admission).enter();
          if (release === null) return await templateBusy(reply);
          const upload = await readTemplateUploadThroughWorker(
            request.body,
            query.workspaceId,
            token,
            deps,
            work.signal,
          );
          const profile = validateTemplateArchive(upload.archive);
          return await reply
            .code(202)
            .send(
              await templates.stageTemplate(
                token,
                templateRequest(
                  upload,
                  profile,
                  query.workspaceId,
                  'managed',
                  query.managedSource,
                  `managed:${query.workspaceId}:${profile.key}:${upload.digest}`,
                ),
                work.signal,
              ),
            );
        } catch (error) {
          return await templateProblem(reply, error, work.signal);
        } finally {
          release?.();
          work.dispose();
        }
      },
    );

    app.delete(
      '/templates/managed/stages/:operationId',
      async (request: FastifyRequest, reply: FastifyReply) => {
        const token = bearer(request.headers.authorization);
        const { operationId } = request.params as { operationId: string };
        if (token === null) {
          return problem(reply, 401, 'unauthenticated', 'A bearer token is required.');
        }
        if (!isUuid(operationId))
          return problem(reply, 404, 'template_not_found', 'No such template.');
        const work = templateWork(request, deps.templateReadTimeoutMs ?? 30_000);
        try {
          await templates.abortStage(token, operationId, work.signal);
          return await reply.code(204).send();
        } catch (error) {
          return await templateProblem(reply, error, work.signal);
        } finally {
          work.dispose();
        }
      },
    );

    app.post(
      '/workspaces/:workspaceId/templates/managed/finalize',
      async (request: FastifyRequest, reply: FastifyReply) => {
        const token = bearer(request.headers.authorization);
        const { workspaceId } = request.params as { workspaceId: string };
        if (token === null) {
          return problem(reply, 401, 'unauthenticated', 'A bearer token is required.');
        }
        if (!isUuid(workspaceId)) {
          return problem(
            reply,
            400,
            'template.finalize_invalid',
            'A workspace UUID, imports and activeStableKeys are required.',
          );
        }
        const work = templateWork(request, deps.templateReadTimeoutMs ?? 30_000);
        try {
          const body = parseManagedFinalizeRequest(request.body);
          await requireTemplateAdmission(templates, token, workspaceId, true, work.signal);
          return await reply.send(
            await templates.finalizeManaged(
              token,
              workspaceId,
              body.imports,
              body.activeStableKeys,
              work.signal,
            ),
          );
        } catch (error) {
          return await templateProblem(reply, error, work.signal);
        } finally {
          work.dispose();
        }
      },
    );

    app.post(
      '/workspaces/:workspaceId/template-stages/expired/sweep',
      async (request: FastifyRequest, reply: FastifyReply) => {
        const token = bearer(request.headers.authorization);
        const { workspaceId } = request.params as { workspaceId: string };
        if (token === null) {
          return problem(reply, 401, 'unauthenticated', 'A bearer token is required.');
        }
        if (!isUuid(workspaceId)) {
          return problem(reply, 404, 'workspace_not_found', 'No such workspace.');
        }
        const work = templateWork(request, deps.templateReadTimeoutMs ?? 30_000);
        try {
          return await reply.send(await templates.sweepExpired(token, workspaceId, work.signal));
        } catch (error) {
          return await templateProblem(reply, error, work.signal);
        } finally {
          work.dispose();
        }
      },
    );
  }

  app.get('/documents/:itemId/export', async (request: FastifyRequest, reply: FastifyReply) => {
    const { itemId } = request.params as { itemId: string };
    const query = request.query as { format?: string; scope?: string };

    const token = bearer(request.headers.authorization);
    if (token === null) {
      return problem(reply, 401, 'unauthenticated', 'A bearer token is required.');
    }

    if (!isUuid(itemId)) {
      // Not-found rather than a validation error, matching Core and the collaboration service: a
      // malformed identifier and one for something the caller may not see get the same answer.
      return problem(reply, 404, 'document_not_found', 'No such item.');
    }

    // Required, with no default. Guessing which of two lossy formats somebody meant is exactly the
    // guess that produces the wrong file, and the two are not interchangeable.
    if (query.format === undefined) {
      return problem(
        reply,
        400,
        'unsupported_format',
        `'format' is required. This service produces ${list(deps.converters.formats())}.`,
      );
    }

    const converter = deps.converters.get(query.format);
    if (converter === null) {
      return problem(
        reply,
        400,
        'unsupported_format',
        `This service does not produce '${query.format}'. It produces ${list(deps.converters.formats())}.`,
      );
    }

    const scope = query.scope ?? 'item';
    if (scope !== 'item' && scope !== 'subtree') {
      return problem(reply, 400, 'invalid_scope', "'scope' must be 'item' or 'subtree'.");
    }

    const release = deps.admission.enter();
    if (release === null) {
      deps.metrics?.admissionsRefused.inc();
      deps.metrics?.exports.inc({ format: converter.format, outcome: 'busy' });

      return reply.code(503).type('application/problem+json').header('retry-after', '5').send({
        type: 'about:blank',
        title: 'Request refused',
        status: 503,
        code: 'busy',
        detail: 'This service is producing as many exports as it can at once. Try again shortly.',
      });
    }

    // One signal for the whole job, passed to the bundle read and checked between chunks, so a
    // conversion that hangs is abandoned rather than held until a proxy gives up on it.
    const timeout = AbortSignal.timeout(deps.jobTimeoutMs);
    const started = process.hrtime.bigint();

    try {
      const stream = await deps.bundles.read({ token, itemId, scope, signal: timeout });

      if (deps.workerExports !== undefined) {
        const staged = await deps.workerExports.storage.stageExport(
          stream,
          converter.format,
          timeout,
        );
        try {
          const created = await deps.workerExports.jobs.createExport(
            token,
            {
              workspaceId: staged.workspaceId,
              format: converter.format,
              sourceUrl: staged.sourceUrl,
              destinationUrl: staged.destinationUrl,
              idempotencyKey: header(request, 'x-idempotency-key') ?? `export:${randomUUID()}`,
            },
            timeout,
          );
          const completed = await deps.workerExports.jobs.wait(token, created.id, timeout);
          if (completed.status !== 'completed') {
            throw new BundleRefusal(
              502,
              completed.errorCode ?? 'export_worker_failed',
              completed.errorDetail ?? 'The export worker could not produce this file.',
            );
          }
          const output = await deps.workerExports.storage.result(staged.destinationKey, timeout);
          deps.metrics?.activeExports.set(deps.admission.inFlight);
          deps.metrics?.exports.inc({ format: converter.format, outcome: 'produced' });
          deps.metrics?.exportSeconds.observe(
            { format: converter.format },
            Number(process.hrtime.bigint() - started) / 1e9,
          );
          output.once('close', () => {
            release();
            void deps.workerExports?.storage.remove(staged);
          });
          return await reply
            .type(converter.mediaType)
            .header(
              'content-disposition',
              `attachment; filename="${exportFileName(titleOf(stream.manifest, itemId), converter.extension)}"`,
            )
            .header('x-nix-export-items', String(stream.manifest.items.length))
            .header('x-nix-export-omitted', String(stream.manifest.omitted.length))
            .header('x-nix-export-loss', String(converter.declaredLoss().length))
            .send(output);
        } catch (error) {
          await deps.workerExports.storage.remove(staged).catch(() => undefined);
          throw error;
        }
      }

      const bytes = boundedBytes(
        converter.convert({
          manifest: stream.manifest,
          bundles: stream.bundles,
          branding: {
            title: titleOf(stream.manifest, itemId),
            exportedAt: deps.now?.() ?? new Date(stream.manifest.exportedAt),
            palette: PRINT_PALETTE,
          },
          // The one thing a converter cannot do for itself: Open XML embeds pictures as bytes, so
          // a view drawn as SVG needs turning into a PNG. Supplied rather than imported, so the
          // converter stays sandboxable.
          host: { rasterise },
        }),
        { maxBytes: deps.maxOutputBytes, signal: timeout },
      );

      const name = exportFileName(titleOf(stream.manifest, itemId), converter.extension);

      deps.metrics?.activeExports.set(deps.admission.inFlight);
      deps.metrics?.exports.inc({ format: converter.format, outcome: 'produced' });
      deps.metrics?.exportSeconds.observe(
        { format: converter.format },
        Number(process.hrtime.bigint() - started) / 1e9,
      );

      // Released when the stream finishes rather than when this handler returns: the conversion is
      // still running after `send`, and releasing here would let the gate admit past its limit.
      const readable = Readable.from(bytes);
      readable.on('close', release);

      return await reply
        .type(converter.mediaType)
        .header('content-disposition', `attachment; filename="${name}"`)
        .header('x-nix-export-items', String(stream.manifest.items.length))
        .header('x-nix-export-omitted', String(stream.manifest.omitted.length))
        // The *declared* loss: what this format cannot carry, known before a node is visited. What
        // this document actually lost is discovered while drawing it and written into the file.
        .header('x-nix-export-loss', String(converter.declaredLoss().length))
        .send(readable);
    } catch (error) {
      release();

      if (error instanceof BundleRefusal || error instanceof WorkerJobRefusal) {
        deps.metrics?.exports.inc({ format: converter.format, outcome: 'refused' });
        return problem(reply, error.status, error.code, error.message);
      }

      if (timeout.aborted) {
        deps.metrics?.exports.inc({ format: converter.format, outcome: 'timed-out' });
        return problem(
          reply,
          504,
          'export_timed_out',
          'This export took longer than the service allows. Export a smaller part of the tree.',
        );
      }

      throw error;
    }
  });

  return app;
}

async function requireTemplateAdmission(
  templates: TemplateImporter,
  token: string,
  workspaceId: string,
  managed: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const admission = await templates.authorizePreview(token, workspaceId, signal);
  const admitted = managed ? admission.canManageTemplates : admission.canWrite;
  if (!admitted) {
    throw new TemplateImportRefusal(
      403,
      managed ? 'template.managed_forbidden' : 'template.import_forbidden',
      managed
        ? 'Only the managed-template service may synchronize this workspace.'
        : 'You cannot import templates into this workspace.',
    );
  }
}

async function readTemplateUpload(
  body: unknown,
  signal: AbortSignal,
): Promise<{
  archive: ReadArchiveResult;
  digest: string;
}> {
  if (!isAsyncBytes(body)) {
    throw new ArchiveReadError(
      'archive.body_missing',
      'Send the template file as application/zip.',
    );
  }
  const source = body;
  const hash = createHash('sha256');
  async function* measured(): AsyncGenerator<Uint8Array> {
    for await (const chunk of source) {
      hash.update(chunk);
      yield chunk;
    }
  }
  const archive = await readArchive(measured(), { signal });
  return { archive, digest: hash.digest('hex') };
}

async function readTemplateUploadThroughWorker(
  body: unknown,
  workspaceId: string,
  token: string,
  deps: ServerDependencies,
  signal: AbortSignal,
): Promise<{ archive: ReadArchiveResult; digest: string }> {
  if (deps.workerImports === undefined) {
    return await readTemplateUpload(body, signal);
  }
  if (!isAsyncBytes(body)) {
    throw new ArchiveReadError(
      'archive.body_missing',
      'Send the template file as application/zip.',
    );
  }
  const staged = await deps.workerImports.storage.stageImport(body, signal);
  try {
    const source = await deps.workerImports.storage.result(staged.sourceKey, signal);
    const upload = await readTemplateUpload(source, signal);
    const root = upload.archive.bundles.find(
      (bundle) => bundle.id === upload.archive.manifest.root,
    );
    if (root === undefined) {
      throw new ArchiveReadError('archive.root_missing', 'The archive root item is missing.');
    }
    const created = await deps.workerImports.jobs.createImport(
      token,
      {
        workspaceId,
        format: 'nix',
        sourceUrl: staged.sourceUrl,
        rootId: root.id,
        title: root.title,
        idempotencyKey: `import-preview:${workspaceId}:${upload.digest}`,
        preview: true,
      },
      signal,
    );
    const completed = await deps.workerImports.jobs.wait(token, created.id, signal);
    if (completed.status !== 'completed') {
      throw new WorkerJobRefusal(
        422,
        completed.errorCode ?? 'import_worker_failed',
        completed.errorDetail ?? 'The Go import worker could not validate this archive.',
      );
    }
    return upload;
  } finally {
    await deps.workerImports.storage.removeImport(staged).catch(() => undefined);
  }
}

function templateRequest(
  upload: { archive: ReadArchiveResult; digest: string },
  profile: ImportedTemplateRequest['profile'],
  workspaceId: string,
  origin: ImportedTemplateRequest['origin'],
  managedSource?: string,
  idempotencyKey = `template-validation:${upload.digest}`,
): ImportedTemplateRequest {
  const request: ImportedTemplateRequest = {
    ...upload.archive,
    profile,
    digest: upload.digest,
    workspaceId,
    origin,
    ...(managedSource === undefined ? {} : { managedSource }),
    idempotencyKey,
  };
  // Measure the actual service request, not the zip's expanded bytes. This is the exact value
  // Fastify applies at the Collab seam and therefore the only bound that proves preview/commit
  // compatibility rather than merely approximating it.
  if (Buffer.byteLength(JSON.stringify(request)) > TEMPLATE_IMPORT_REQUEST_BYTES) {
    throw new ArchiveReadError(
      'template.import_plan_too_large',
      'The validated template expands beyond the collaboration import request limit.',
    );
  }
  return request;
}

function templateProblem(reply: FastifyReply, error: unknown, signal?: AbortSignal): FastifyReply {
  if (error instanceof ArchiveReadError) {
    return problem(
      reply,
      error.code === 'archive.timed_out' ? 408 : 400,
      error.code,
      error.message,
    );
  }
  if (error instanceof TemplateImportRefusal) {
    return problem(reply, error.status, error.code, error.message);
  }
  if (error instanceof WorkerJobRefusal) {
    return problem(reply, error.status, error.code, error.message);
  }
  if (signal?.aborted === true) {
    return problem(
      reply,
      signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError' ? 408 : 499,
      signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError'
        ? 'template.timed_out'
        : 'template.cancelled',
      signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError'
        ? 'The template operation exceeded its deadline.'
        : 'The template operation was cancelled when the request disconnected.',
    );
  }
  throw error;
}

function templateBusy(reply: FastifyReply): FastifyReply {
  return reply.code(503).type('application/problem+json').header('retry-after', '5').send({
    type: 'about:blank',
    title: 'Request refused',
    status: 503,
    code: 'template.busy',
    detail: 'This service is parsing as many template files as it can at once. Try again shortly.',
  });
}

function templateWork(
  request: FastifyRequest,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const disconnected = new AbortController();
  const timeout = AbortSignal.timeout(timeoutMs);
  const onDisconnect = (): void => {
    disconnected.abort(new DOMException('The request disconnected.', 'AbortError'));
  };
  request.raw.socket.once('close', onDisconnect);
  request.raw.once('aborted', onDisconnect);
  return {
    signal: AbortSignal.any([timeout, disconnected.signal]),
    dispose: () => {
      request.raw.socket.off('close', onDisconnect);
      request.raw.off('aborted', onDisconnect);
    },
  };
}

function isAsyncBytes(value: unknown): value is AsyncIterable<Uint8Array> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

function header(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function sameDigest(expected: string | null, actual: string): boolean {
  if (expected === null || !/^[0-9a-f]{64}$/i.test(expected)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}

/**
 * The document's title, for the file name and the first page.
 *
 * Read from the manifest's own spine rather than fetched from Core: this service has no Core
 * credentials and no reason to acquire any, and the manifest already names every item it carries.
 */
function titleOf(
  manifest: { items: readonly { id: string; title: string }[] },
  root: string,
): string {
  return manifest.items.find((item) => item.id === root)?.title ?? 'Export';
}

function list(formats: readonly string[]): string {
  return formats.length === 0 ? 'nothing' : formats.join(' and ');
}
