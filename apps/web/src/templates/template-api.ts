import {
  defineBinaryQuery,
  defineCommand,
  defineQuery,
  templateImportPreviewSchema,
  templateImportResultSchema,
  templateImportSchema,
  templateImportUploadSchema,
  templateItemSchema,
  files as coreFiles,
  operations as coreOperations,
  templateImports as coreTemplateImports,
  templates as coreTemplates,
  type BeginTemplateImportInput,
  type BinaryQueryEndpoint,
  type CommandEndpoint,
  type NixClient,
  type QueryEndpoint,
  type TemplateCatalog,
  type TemplateDetail,
  type TemplateImport,
  type TemplateImportPreview,
  type TemplateImportResult,
  type TemplateImportUpload,
  type TemplateItem,
  type TemplatePreflight,
  type TemplatePreflightInput,
  type TemplateSummary,
} from '@nix/api-client';
import { z } from 'zod';

import {
  ContainerViewsSchema,
  EffectiveSchemaSchema,
  type EffectiveSchema,
} from '../views/core/container-model';

export {
  templateCapabilitiesSchema as TemplateCapabilitiesSchema,
  templateCatalogSchema as TemplateLibraryResponseSchema,
  templateDetailSchema as TemplateDetailSchema,
  templateItemSchema as TemplateItemSchema,
  templateOriginSchema as TemplateOriginSchema,
  templatePreflightSchema as TemplatePreflightSchema,
  templateSummarySchema as TemplateSummarySchema,
} from '@nix/api-client';
export type { TemplateDetail, TemplateItem, TemplatePreflight, TemplateSummary };
export type TemplateLibraryResponse = TemplateCatalog;

export const TemplateEditDraftSchema = z.object({
  operationId: z.string(),
  templateId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  expiresAt: z.string(),
  root: templateItemSchema,
});

export type TemplateEditDraft = z.infer<typeof TemplateEditDraftSchema>;

export const TemplateCaptureSchema = z.object({
  templateId: z.string(),
  operationId: z.string(),
  writtenTargetItemIds: z.array(z.string()),
});

export const TemplateApplicationSchema = z.object({
  applicationId: z.string(),
  templateId: z.string(),
  targetItemId: z.string(),
  alreadyApplied: z.boolean(),
  createdItems: z.array(
    z.object({ sourceId: z.string(), itemId: z.string(), itemType: z.string() }),
  ),
  writtenTargetItemIds: z.array(z.string()),
  operationId: z.string(),
});

export type TemplateApplication = z.infer<typeof TemplateApplicationSchema>;

export {
  templateImportPreviewSchema as TemplateImportPreviewSchema,
  templateImportResultSchema as TemplateImportResultSchema,
  templateImportSchema as TemplateImportSchema,
  templateImportUploadSchema as TemplateImportUploadSchema,
};
export type { TemplateImport, TemplateImportPreview, TemplateImportResult, TemplateImportUpload };

const templateLibraryKey = coreTemplates.templateLibraryKey;
const templateKey = coreTemplates.templateKey;

export const templateImportById = coreTemplateImports.byId;

export async function beginAndPreviewTemplate(
  client: NixClient,
  input: BeginTemplateImportInput,
  source: Blob,
  signal?: AbortSignal,
  onStarted?: (importId: string) => void,
): Promise<TemplateImport> {
  if (source.size !== input.byteLength) {
    throw new RangeError('The template upload size does not match its declared byte length.');
  }

  const upload = await client.execute(coreTemplateImports.begin(input), { signal });
  onStarted?.(upload.id);
  let templateImport: TemplateImport | null = null;
  try {
    if (upload.uploadUrl !== null) {
      await coreFiles.putUploadCapability(upload.uploadUrl, source, signal);
      const queued = await client.execute(coreTemplateImports.preview(upload.id), { signal });
      await coreOperations.waitForOperation(
        client,
        queued.id,
        signal === undefined ? {} : { signal },
      );
    } else {
      templateImport = await client.query(coreTemplateImports.byId(upload.id), {
        signal,
        forceRefresh: true,
      });
      if (
        templateImport.status === 'preview_queued' &&
        templateImport.previewOperationId !== null
      ) {
        await coreOperations.waitForOperation(
          client,
          templateImport.previewOperationId,
          signal === undefined ? {} : { signal },
        );
        templateImport = null;
      }
    }

    templateImport ??= await client.query(coreTemplateImports.byId(upload.id), {
      signal,
      forceRefresh: true,
    });
    if (!hasTemplatePreview(templateImport)) {
      throw new Error(
        templateImport.failureCode ??
          (upload.uploadUrl === null
            ? 'The template upload capability is no longer available. Start a new import.'
            : 'The template preview did not become ready.'),
      );
    }
    return templateImport;
  } catch (error) {
    if (signal?.aborted === true) throw error;
    const recovered = await readTemplateImport(client, upload.id, signal);
    const resumed = await resumeTemplatePreview(client, recovered, signal).catch(
      (recoveryError: unknown) => {
        if (signal?.aborted === true) throw recoveryError;
        return null;
      },
    );
    if (resumed !== null && hasTemplatePreview(resumed)) return resumed;
    throw error;
  }
}

export async function commitAndWaitTemplate(
  client: NixClient,
  importId: string,
  expectedDigest: string,
  signal?: AbortSignal,
): Promise<TemplateImport> {
  let templateImport: TemplateImport | null = null;
  try {
    const queued = await client.execute(coreTemplateImports.commit(importId, expectedDigest), {
      signal,
    });
    await coreOperations.waitForOperation(
      client,
      queued.id,
      signal === undefined ? {} : { signal },
    );
  } catch (error) {
    if (signal?.aborted === true) throw error;
    templateImport = await readTemplateImport(client, importId, signal);
    templateImport = await resumeTemplateCommit(client, templateImport, signal).catch(
      (recoveryError: unknown) => {
        if (signal?.aborted === true) throw recoveryError;
        return templateImport;
      },
    );
    if (!isCompletedTemplateImport(templateImport)) throw error;
  }

  templateImport ??= await client.query(coreTemplateImports.byId(importId), {
    signal,
    forceRefresh: true,
  });
  if (!isCompletedTemplateImport(templateImport)) {
    throw new Error(templateImport.failureCode ?? 'The template import did not publish.');
  }
  client.invalidate(['workspaces', templateImport.workspaceId, 'templates']);
  return templateImport;
}

export async function cancelTemplateImport(
  client: NixClient,
  importId: string,
  signal?: AbortSignal,
): Promise<void> {
  await client.execute(
    coreTemplateImports.cancel(importId),
    signal === undefined ? {} : { signal },
  );
}

async function readTemplateImport(
  client: NixClient,
  importId: string,
  signal?: AbortSignal,
): Promise<TemplateImport | null> {
  try {
    return await client.query(coreTemplateImports.byId(importId), {
      signal,
      forceRefresh: true,
    });
  } catch (error) {
    if (signal?.aborted === true) throw error;
    return null;
  }
}

async function resumeTemplatePreview(
  client: NixClient,
  templateImport: TemplateImport | null,
  signal?: AbortSignal,
): Promise<TemplateImport | null> {
  if (templateImport !== null && hasTemplatePreview(templateImport)) return templateImport;
  if (templateImport?.status !== 'preview_queued' || templateImport.previewOperationId === null) {
    return templateImport;
  }
  await coreOperations.waitForOperation(
    client,
    templateImport.previewOperationId,
    signal === undefined ? {} : { signal },
  );
  return await client.query(coreTemplateImports.byId(templateImport.id), {
    signal,
    forceRefresh: true,
  });
}

async function resumeTemplateCommit(
  client: NixClient,
  templateImport: TemplateImport | null,
  signal?: AbortSignal,
): Promise<TemplateImport | null> {
  if (templateImport !== null && isCompletedTemplateImport(templateImport)) return templateImport;
  if (
    templateImport === null ||
    !['commit_queued', 'staging', 'staged'].includes(templateImport.status) ||
    templateImport.commitOperationId === null
  ) {
    return templateImport;
  }
  await coreOperations.waitForOperation(
    client,
    templateImport.commitOperationId,
    signal === undefined ? {} : { signal },
  );
  return await client.query(coreTemplateImports.byId(templateImport.id), {
    signal,
    forceRefresh: true,
  });
}

function hasTemplatePreview(templateImport: TemplateImport | null): boolean {
  return (
    templateImport !== null &&
    ['preview_ready', 'commit_queued', 'staging', 'staged', 'completed'].includes(
      templateImport.status,
    ) &&
    templateImport.preview !== null
  );
}

function isCompletedTemplateImport(templateImport: TemplateImport | null): boolean {
  return templateImport?.status === 'completed' && templateImport.result !== null;
}

export const listTemplates = coreTemplates.listTemplates;
export const templateById = coreTemplates.templateById;

export function templateCaptureSourceSchema(itemId: string): QueryEndpoint<EffectiveSchema> {
  return defineQuery({
    operation: 'templates.capture-source.schema',
    path: `/api/v1/items/${itemId}/schema`,
    schema: EffectiveSchemaSchema,
    cacheKey: ['items', itemId, 'schema'],
  });
}

export function templateCaptureSourceViews(
  itemId: string,
): QueryEndpoint<z.infer<typeof ContainerViewsSchema>> {
  return defineQuery({
    operation: 'templates.capture-source.views',
    path: `/api/v1/items/${itemId}/views`,
    schema: ContainerViewsSchema,
    cacheKey: ['items', itemId, 'views'],
  });
}

export function templateEditDraftById(
  templateId: string,
  operationId: string,
): QueryEndpoint<TemplateEditDraft> {
  return defineQuery({
    operation: 'templates.drafts.get',
    path: `/collab/templates/${templateId}/drafts/${operationId}`,
    schema: TemplateEditDraftSchema,
    cacheKey: [...templateKey(templateId), 'drafts', operationId],
    staleAfterMs: 0,
  });
}

export function beginTemplateEditDraft(
  templateId: string,
  idempotencyKey: string,
): CommandEndpoint<TemplateEditDraft> {
  return defineCommand({
    operation: 'templates.drafts.begin',
    method: 'POST',
    path: `/collab/templates/${templateId}/drafts`,
    body: { idempotencyKey },
    schema: TemplateEditDraftSchema,
    invalidates: [[...templateKey(templateId), 'drafts']],
  });
}

export function updateTemplateEditDraft(
  templateId: string,
  operationId: string,
  input: { readonly title?: string | undefined; readonly description?: string | null | undefined },
): CommandEndpoint<TemplateEditDraft> {
  return defineCommand({
    operation: 'templates.drafts.update',
    method: 'PATCH',
    path: `/collab/templates/${templateId}/drafts/${operationId}`,
    body: input,
    schema: TemplateEditDraftSchema,
    invalidates: [[...templateKey(templateId), 'drafts', operationId]],
  });
}

export function updateTemplateEditDraftItem(
  templateId: string,
  operationId: string,
  sourceId: string,
  input: {
    readonly title?: string | undefined;
    readonly properties?: Readonly<Record<string, unknown>> | null | undefined;
    readonly schema?: EffectiveSchema | null | undefined;
    readonly views?: TemplateItem['views'];
  },
): CommandEndpoint<TemplateItem> {
  const schema =
    input.schema === undefined || input.schema === null
      ? input.schema
      : { properties: input.schema.declared, inherit: input.schema.inherit };
  return defineCommand({
    operation: 'templates.drafts.items.update',
    method: 'PATCH',
    path: `/collab/templates/${templateId}/drafts/${operationId}/items/${sourceId}`,
    body: { ...input, schema },
    schema: templateItemSchema,
    invalidates: [[...templateKey(templateId), 'drafts', operationId]],
  });
}

export function saveTemplateEditDraft(
  template: TemplateSummary,
  operationId: string,
): CommandEndpoint<z.infer<typeof FinalizeTemplateEditDraftSchema>> {
  return defineCommand({
    operation: 'templates.drafts.save',
    method: 'POST',
    path: `/collab/templates/${template.id}/drafts/${operationId}/save`,
    body: {},
    schema: FinalizeTemplateEditDraftSchema,
    invalidates: [templateKey(template.id), templateLibraryKey(template.workspaceId)],
  });
}

export function discardTemplateEditDraft(
  templateId: string,
  operationId: string,
): CommandEndpoint<undefined> {
  return defineCommand({
    operation: 'templates.drafts.discard',
    method: 'DELETE',
    path: `/collab/templates/${templateId}/drafts/${operationId}`,
    schema: z.undefined(),
    invalidates: [[...templateKey(templateId), 'drafts', operationId]],
  });
}

const FinalizeTemplateEditDraftSchema = z.object({ templateId: z.string() });

export const deleteTemplate = coreTemplates.deleteTemplate;

export function exportTemplate(templateId: string): BinaryQueryEndpoint {
  return defineBinaryQuery({
    operation: 'templates.export',
    path: `/collab/templates/${templateId}/export`,
  });
}

export type { TemplatePreflightInput };
export const preflightTemplate = coreTemplates.preflightTemplate;

export interface CaptureTemplateInput {
  readonly workspaceId: string;
  readonly sourceItemId: string;
  readonly title: string;
  readonly description: string | null;
  readonly includeBody: boolean;
  readonly includeChildren: boolean;
  readonly idempotencyKey: string;
}

export function captureTemplate(
  input: CaptureTemplateInput,
): CommandEndpoint<z.infer<typeof TemplateCaptureSchema>> {
  return defineCommand({
    operation: 'templates.capture',
    method: 'POST',
    path: '/collab/templates/captures',
    body: input,
    schema: TemplateCaptureSchema,
    invalidates: [templateLibraryKey(input.workspaceId)],
  });
}

export interface ApplyTemplateInput {
  readonly templateId: string;
  readonly mode: 'merge' | 'create';
  readonly targetItemId?: string | undefined;
  readonly parentItemId?: string | null | undefined;
  readonly title?: string | undefined;
  readonly idempotencyKey: string;
}

export function applyStoredTemplate(
  input: ApplyTemplateInput,
): CommandEndpoint<TemplateApplication> {
  return defineCommand({
    operation: 'templates.apply',
    method: 'POST',
    path: '/collab/templates/applications',
    body: input,
    schema: TemplateApplicationSchema,
    invalidates: [['items'], ['templates', input.templateId]],
  });
}
