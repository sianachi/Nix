import { Readable } from 'node:stream';

import { TEMPLATE_IMPORT_REQUEST_BYTES, exportFileName, writeArchive } from '@nix/export';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { TemplateBodyError } from '../../templates/bodies.ts';
import { CoreTemplateError } from '../../templates/core.ts';
import {
  parseApplicationRequest,
  parseBeginDraftRequest,
  parseCaptureRequest,
  parseDraftItemPatch,
  parseDraftMetadataPatch,
  parseImportedTemplate,
  parseManagedFinalizeRequest,
  TemplateHttpContractError,
} from '../../templates/http-contracts.ts';
import type { TemplateService } from '../../templates/service.ts';
import type { RouteDependencies } from '../context.ts';
import { internalCaller, isUuid, problem, requestToken } from '../replies.ts';

/** Template export, capture, application, drafts, imports and managed-template upkeep. */
export function registerTemplateRoutes(
  app: FastifyInstance,
  deps: RouteDependencies,
  templates: TemplateService,
): void {
  app.get('/templates/:templateId/export', async (request: FastifyRequest, reply: FastifyReply) => {
    const token = requestToken(request, reply);
    if (token === null) return reply;
    const { templateId } = request.params as { templateId: string };
    if (!isUuid(templateId)) {
      return problem(reply, 404, 'template_not_found', 'No such template.');
    }
    try {
      const controller = new AbortController();
      const abortExport = () => {
        controller.abort(new Error('The export client disconnected.'));
      };
      request.raw.once('aborted', abortExport);
      reply.raw.once('close', () => {
        if (!reply.raw.writableEnded) abortExport();
      });
      const prepared = await templates.exportTemplate(
        token,
        templateId,
        deps.now?.() ?? new Date(),
        controller.signal,
      );
      return await reply
        .type('application/zip')
        .header(
          'content-disposition',
          `attachment; filename="${exportFileName(prepared.title, 'nix')}"`,
        )
        .header('x-nix-export-items', String(prepared.manifest.items.length))
        .header('x-nix-export-omitted', '0')
        .header('x-nix-export-loss', '0')
        .send(Readable.from(writeArchive(prepared)));
    } catch (error) {
      return templateProblem(reply, error);
    }
  });

  app.post('/templates/captures', async (request: FastifyRequest, reply: FastifyReply) => {
    const token = requestToken(request, reply);
    if (token === null) return reply;
    try {
      return await reply
        .code(201)
        .send(await templates.capture(token, parseCaptureRequest(request.body)));
    } catch (error) {
      return templateProblem(reply, error);
    }
  });

  app.post('/templates/applications', async (request: FastifyRequest, reply: FastifyReply) => {
    const token = requestToken(request, reply);
    if (token === null) return reply;
    try {
      return await reply
        .code(201)
        .send(await templates.apply(token, parseApplicationRequest(request.body)));
    } catch (error) {
      return templateProblem(reply, error);
    }
  });

  app.post(
    '/templates/:templateId/drafts',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const token = requestToken(request, reply);
      if (token === null) return reply;
      const { templateId } = request.params as { templateId: string };
      if (!isUuid(templateId)) {
        return problem(
          reply,
          400,
          'template.draft_invalid',
          'A template ID and idempotency key are required.',
        );
      }
      try {
        const body = parseBeginDraftRequest(request.body);
        return await reply
          .code(201)
          .send(await templates.beginDraft(token, templateId, body.idempotencyKey));
      } catch (error) {
        return templateProblem(reply, error);
      }
    },
  );

  app.get(
    '/templates/:templateId/drafts/:operationId',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const token = requestToken(request, reply);
      if (token === null) return reply;
      const { templateId, operationId } = request.params as {
        templateId: string;
        operationId: string;
      };
      if (!isUuid(templateId) || !isUuid(operationId)) {
        return problem(reply, 404, 'template_not_found', 'No such template draft.');
      }
      try {
        return await reply.send(await templates.getDraft(token, templateId, operationId));
      } catch (error) {
        return templateProblem(reply, error);
      }
    },
  );

  app.patch(
    '/templates/:templateId/drafts/:operationId',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const token = requestToken(request, reply);
      if (token === null) return reply;
      const { templateId, operationId } = request.params as {
        templateId: string;
        operationId: string;
      };
      if (!isUuid(templateId) || !isUuid(operationId)) {
        return problem(reply, 404, 'template_not_found', 'No such template draft.');
      }
      try {
        return await reply.send(
          await templates.patchDraft(
            token,
            templateId,
            operationId,
            parseDraftMetadataPatch(request.body),
          ),
        );
      } catch (error) {
        return templateProblem(reply, error);
      }
    },
  );

  app.patch(
    '/templates/:templateId/drafts/:operationId/items/:sourceId',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const token = requestToken(request, reply);
      if (token === null) return reply;
      const { templateId, operationId, sourceId } = request.params as {
        templateId: string;
        operationId: string;
        sourceId: string;
      };
      if (!isUuid(templateId) || !isUuid(operationId) || !isUuid(sourceId)) {
        return problem(reply, 404, 'template_not_found', 'No such template draft item.');
      }
      try {
        return await reply.send(
          await templates.patchDraftItem(
            token,
            templateId,
            operationId,
            sourceId,
            parseDraftItemPatch(request.body),
          ),
        );
      } catch (error) {
        return templateProblem(reply, error);
      }
    },
  );

  app.post(
    '/templates/:templateId/drafts/:operationId/save',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const token = requestToken(request, reply);
      if (token === null) return reply;
      const { templateId, operationId } = request.params as {
        templateId: string;
        operationId: string;
      };
      if (!isUuid(templateId) || !isUuid(operationId)) {
        return problem(reply, 404, 'template_not_found', 'No such template draft.');
      }
      try {
        return await reply.send(await templates.saveDraft(token, templateId, operationId));
      } catch (error) {
        return templateProblem(reply, error);
      }
    },
  );

  app.delete(
    '/templates/:templateId/drafts/:operationId',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const token = requestToken(request, reply);
      if (token === null) return reply;
      const { templateId, operationId } = request.params as {
        templateId: string;
        operationId: string;
      };
      if (!isUuid(templateId) || !isUuid(operationId)) {
        return problem(reply, 404, 'template_not_found', 'No such template draft.');
      }
      try {
        await templates.discardDraft(token, templateId, operationId);
        return await reply.code(204).send();
      } catch (error) {
        return templateProblem(reply, error);
      }
    },
  );

  app.post(
    '/templates/imports/validate',
    { bodyLimit: TEMPLATE_IMPORT_REQUEST_BYTES },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!internalCaller(request, deps.internalSecret)) {
        return problem(reply, 404, 'template_not_found', 'No such template.');
      }
      const token = requestToken(request, reply);
      if (token === null) return reply;
      try {
        return await reply.send(
          await templates.validateImport(token, parseImportedTemplate(request.body)),
        );
      } catch (error) {
        return templateProblem(reply, error);
      }
    },
  );

  app.post(
    '/templates/imports',
    { bodyLimit: TEMPLATE_IMPORT_REQUEST_BYTES },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!internalCaller(request, deps.internalSecret)) {
        return problem(reply, 404, 'template_not_found', 'No such template.');
      }
      const token = requestToken(request, reply);
      if (token === null) return reply;
      try {
        return await reply
          .code(201)
          .send(await templates.importTemplate(token, parseImportedTemplate(request.body)));
      } catch (error) {
        return templateProblem(reply, error);
      }
    },
  );

  app.post(
    '/templates/imports/stage',
    { bodyLimit: TEMPLATE_IMPORT_REQUEST_BYTES },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!internalCaller(request, deps.internalSecret)) {
        return problem(reply, 404, 'template_not_found', 'No such template.');
      }
      const token = requestToken(request, reply);
      if (token === null) return reply;
      try {
        return await reply
          .code(202)
          .send(await templates.stageImport(token, parseImportedTemplate(request.body)));
      } catch (error) {
        return templateProblem(reply, error);
      }
    },
  );

  app.delete(
    '/templates/imports/:operationId',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!internalCaller(request, deps.internalSecret)) {
        return problem(reply, 404, 'template_not_found', 'No such template.');
      }
      const token = requestToken(request, reply);
      if (token === null) return reply;
      const { operationId } = request.params as { operationId: string };
      if (!isUuid(operationId))
        return problem(reply, 404, 'template_not_found', 'No such template.');
      try {
        await templates.abortImport(token, operationId);
        return await reply.code(204).send();
      } catch (error) {
        return templateProblem(reply, error);
      }
    },
  );

  app.post(
    '/workspaces/:workspaceId/templates/managed/finalize',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!internalCaller(request, deps.internalSecret)) {
        return problem(reply, 404, 'workspace_not_found', 'No such workspace.');
      }
      const token = requestToken(request, reply);
      if (token === null) return reply;
      const { workspaceId } = request.params as { workspaceId: string };
      if (!isUuid(workspaceId)) {
        return problem(
          reply,
          400,
          'template.finalize_invalid',
          'A workspace UUID, imports and activeStableKeys are required.',
        );
      }
      try {
        const body = parseManagedFinalizeRequest(request.body);
        return await reply.send(
          await templates.finalizeManaged(token, workspaceId, body.imports, body.activeStableKeys),
        );
      } catch (error) {
        return templateProblem(reply, error);
      }
    },
  );

  app.post(
    '/workspaces/:workspaceId/template-stages/expired/sweep',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!internalCaller(request, deps.internalSecret)) {
        return problem(reply, 404, 'workspace_not_found', 'No such workspace.');
      }
      const token = requestToken(request, reply);
      if (token === null) return reply;
      const { workspaceId } = request.params as { workspaceId: string };
      if (!isUuid(workspaceId))
        return problem(reply, 404, 'workspace_not_found', 'No such workspace.');
      try {
        return await reply.send(await templates.sweepExpired(token, workspaceId));
      } catch (error) {
        return templateProblem(reply, error);
      }
    },
  );

  app.get(
    '/workspaces/:workspaceId/templates/import-authorization',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!internalCaller(request, deps.internalSecret)) {
        return problem(reply, 404, 'workspace_not_found', 'No such workspace.');
      }
      const token = requestToken(request, reply);
      if (token === null) return reply;
      const { workspaceId } = request.params as { workspaceId: string };
      if (!isUuid(workspaceId))
        return problem(reply, 404, 'workspace_not_found', 'No such workspace.');
      try {
        return await reply.send(await templates.authorizeImport(token, workspaceId));
      } catch (error) {
        return templateProblem(reply, error);
      }
    },
  );
}

function templateProblem(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof TemplateHttpContractError) {
    return problem(reply, error.status, error.code, error.message);
  }
  if (error instanceof CoreTemplateError) {
    return problem(reply, error.status, error.code, error.message);
  }
  if (error instanceof TemplateBodyError) {
    return problem(
      reply,
      error.code === 'templates.conflict' ? 409 : 422,
      error.code,
      error.message,
    );
  }
  throw error;
}
