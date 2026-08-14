import { Readable } from 'node:stream';

import { PRINT_PALETTE } from '@nix/design-tokens/print';
import { exportFileName, type ConverterRegistry } from '@nix/export';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { BundleRefusal, type BundleReader } from '../collab/bundles.ts';
import type { Admission } from '../export/admission.ts';
import { rasterise } from '../export/rasterise.ts';
import { boundedBytes } from '../export/run.ts';
import type { MediaMetrics } from '../metrics.ts';
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
  readonly jobTimeoutMs: number;
  readonly maxOutputBytes: number;
  readonly metrics?: MediaMetrics | undefined;
  readonly logLevel?: string | undefined;

  /** Injected so a produced file's metadata does not depend on the wall clock in a test. */
  readonly now?: (() => Date) | undefined;
}

export function createServer(deps: ServerDependencies): FastifyInstance {
  const app = Fastify({
    logger: process.env.NODE_ENV === 'test' ? false : { level: deps.logLevel ?? 'info' },
  });

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

      if (error instanceof BundleRefusal) {
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
