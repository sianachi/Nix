import {
  defineBinaryQuery,
  defineCommand,
  defineQuery,
  templateItemSchema,
  templates as coreTemplates,
  type BinaryQueryEndpoint,
  type CommandEndpoint,
  type QueryEndpoint,
  type TemplateCatalog,
  type TemplateDetail,
  type TemplateItem,
  type TemplatePreflight,
  type TemplatePreflightInput,
  type TemplateSummary,
} from '@nix/api-client';
import { z } from 'zod';

import { ContainerViewsSchema, EffectiveSchemaSchema } from '../views/core/container-model';

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

export const TemplateImportPreviewSchema = z.object({
  profile: z.object({
    kind: z.literal('template'),
    version: z.number().int().positive(),
    key: z.string(),
    name: z.string(),
    description: z.string(),
    includeBody: z.boolean(),
    includeChildren: z.boolean(),
  }),
  digest: z.string(),
  rootItemType: z.string(),
  itemCount: z.number().int().positive(),
  bodyCount: z.number().int().nonnegative(),
  viewCount: z.number().int().nonnegative(),
});

export type TemplateImportPreview = z.infer<typeof TemplateImportPreviewSchema>;

export const TemplateImportResultSchema = z.object({
  templateId: z.string(),
  stableKey: z.string(),
  unchanged: z.boolean(),
  writtenTargetItemIds: z.array(z.string()),
});

const templateLibraryKey = coreTemplates.templateLibraryKey;
const templateKey = coreTemplates.templateKey;

export const listTemplates = coreTemplates.listTemplates;
export const templateById = coreTemplates.templateById;

export function templateCaptureSourceSchema(
  itemId: string,
): QueryEndpoint<z.infer<typeof EffectiveSchemaSchema>> {
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
    readonly schema?: z.infer<typeof EffectiveSchemaSchema> | null | undefined;
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

export function previewTemplateFile(
  workspaceId: string,
  file: Blob,
): CommandEndpoint<TemplateImportPreview> {
  return defineCommand({
    operation: 'templates.import.preview',
    method: 'POST',
    path: '/media/templates/preview',
    query: { workspaceId },
    body: file,
    schema: TemplateImportPreviewSchema,
  });
}

export function importTemplateFile(
  workspaceId: string,
  file: Blob,
  expectedDigest: string,
  idempotencyKey: string,
): CommandEndpoint<z.infer<typeof TemplateImportResultSchema>> {
  return defineCommand({
    operation: 'templates.import.commit',
    method: 'POST',
    path: '/media/templates/commit',
    query: { workspaceId, origin: 'user' },
    body: file,
    headers: {
      'x-nix-template-digest': expectedDigest,
      'x-idempotency-key': idempotencyKey,
    },
    schema: TemplateImportResultSchema,
    invalidates: [templateLibraryKey(workspaceId)],
  });
}
