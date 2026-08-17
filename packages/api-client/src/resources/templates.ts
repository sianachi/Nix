/** Workspace templates: Core-owned catalog, detail, validation and deletion endpoints. */

import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import {
  noContentSchema,
  templateCatalogSchema,
  templateDetailSchema,
  templateItemSchema,
  templatePreflightRequestSchema,
  templatePreflightSchema,
  type TemplateCatalog,
  type TemplateDetail,
  type TemplateItem,
  type TemplatePreflight,
  type TemplatePreflightInput,
  type TemplateSummary,
} from '../schemas/index.js';

/** Cache identity shared by every read and mutation of one workspace's template catalog. */
export const templateLibraryKey = (workspaceId: string): readonly string[] => [
  'workspaces',
  workspaceId,
  'templates',
];

/** Cache identity shared by a template detail and mutations of that template. */
export const templateKey = (templateId: string): readonly string[] => ['templates', templateId];

export const listTemplates = (workspaceId: string): QueryEndpoint<TemplateCatalog> =>
  defineQuery({
    operation: 'templates.list',
    path: `/api/v1/workspaces/${workspaceId}/templates`,
    schema: templateCatalogSchema,
    cacheKey: templateLibraryKey(workspaceId),
  });

export const templateById = (templateId: string): QueryEndpoint<TemplateDetail> =>
  defineQuery({
    operation: 'templates.get',
    path: `/api/v1/templates/${templateId}`,
    schema: templateDetailSchema,
    cacheKey: templateKey(templateId),
  });

export const templateItemById = (
  templateId: string,
  sourceId: string,
): QueryEndpoint<TemplateItem> =>
  defineQuery({
    operation: 'templates.items.get',
    path: `/api/v1/templates/${templateId}/items/${sourceId}`,
    schema: templateItemSchema,
    cacheKey: [...templateKey(templateId), 'items', sourceId],
  });

export const deleteTemplate = (template: TemplateSummary): CommandEndpoint<undefined> =>
  defineCommand({
    operation: 'templates.delete',
    method: 'DELETE',
    path: `/api/v1/templates/${template.id}`,
    schema: noContentSchema,
    invalidates: [templateKey(template.id), templateLibraryKey(template.workspaceId)],
  });

export const preflightTemplate = (
  templateId: string,
  input: TemplatePreflightInput,
): CommandEndpoint<TemplatePreflight> =>
  defineCommand({
    operation: 'templates.preflight',
    method: 'POST',
    path: `/api/v1/templates/${templateId}/preflight`,
    body: templatePreflightRequestSchema.parse(input),
    schema: templatePreflightSchema,
  });
