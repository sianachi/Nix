import { TEMPLATE_IMPORT_REQUEST_BYTES } from '@nix/export';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { importBodyProblem } from '../../imports/bodies.ts';
import { CoreImportError } from '../../imports/core.ts';
import { TemplateImportBodyError } from '../../template-imports/bodies.ts';
import { CoreTemplateImportError } from '../../template-imports/core.ts';
import type { RouteDependencies } from '../context.ts';
import { internalCaller } from '../auth.ts';
import { isUuid, stringHeader } from '../params.ts';
import { problem } from '../replies.ts';

/** The worker-facing body writes for staged document and template imports. Internal only. */
export function registerInternalImportRoutes(app: FastifyInstance, deps: RouteDependencies): void {
  const importBodies = deps.importBodies;
  if (importBodies !== undefined) {
    app.post(
      '/internal/imports/:importId/bodies',
      { bodyLimit: 16 * 1024 * 1024 },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const { importId } = request.params as { importId: string };
        const jobId = stringHeader(request, 'x-nix-worker-job-id');
        const executionId = stringHeader(request, 'x-nix-worker-execution-id');
        if (
          !internalCaller(request, deps.internalSecret) ||
          !isUuid(importId) ||
          jobId === null ||
          executionId === null
        ) {
          return problem(reply, 404, 'import_not_found', 'No such staged import is available.');
        }
        try {
          return await reply.send(
            await importBodies.write({
              importId,
              jobId,
              executionId,
              body: request.body,
            }),
          );
        } catch (error) {
          if (error instanceof CoreImportError) {
            return problem(reply, error.status, error.code, error.message);
          }
          const refusal = importBodyProblem(error);
          if (refusal !== null) {
            return problem(reply, refusal.status, refusal.code, refusal.message);
          }
          throw error;
        }
      },
    );
  }

  const templateImportBodies = deps.templateImportBodies;
  if (templateImportBodies !== undefined) {
    app.post(
      '/internal/worker-executions/template-imports/:importId/bodies',
      { bodyLimit: TEMPLATE_IMPORT_REQUEST_BYTES },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const { importId } = request.params as { importId: string };
        const jobId = stringHeader(request, 'x-nix-worker-job-id');
        const executionId = stringHeader(request, 'x-nix-worker-execution-id');
        if (
          !internalCaller(request, deps.internalSecret) ||
          !isUuid(importId) ||
          jobId === null ||
          executionId === null
        ) {
          return problem(
            reply,
            404,
            'template.import_not_found',
            'No such template import is available.',
          );
        }
        try {
          return await reply.send(
            await templateImportBodies.write({
              importId,
              jobId,
              executionId,
              body: request.body,
            }),
          );
        } catch (error) {
          if (error instanceof CoreTemplateImportError) {
            return problem(reply, error.status, error.code, error.message);
          }
          if (error instanceof TemplateImportBodyError) {
            return problem(reply, error.status, error.code, error.message);
          }
          throw error;
        }
      },
    );
  }
}
