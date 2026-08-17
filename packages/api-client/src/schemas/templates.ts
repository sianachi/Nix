/**
 * Workspace-template boundary schemas.
 *
 * Core stores captured schemas and views as JSON objects so older archives remain readable. The
 * client still validates the vocabulary it renders and fills the additive defaults introduced by
 * later view versions. That normalization happens here, at the API boundary, rather than in each
 * template screen.
 */

import { z } from 'zod';
import type {
  TemplateCatalogContract,
  TemplateDetailContract,
  TemplateItemContract,
  TemplatePreflightContract,
  TemplatePreflightRequestContract,
  TemplateSummaryContract,
} from '../contracts.js';

const nonnegativeInt32Schema = z
  .union([z.int().nonnegative(), z.string().regex(/^\d+$/)])
  .transform(Number)
  .pipe(z.int().nonnegative().max(2_147_483_647));

export const templateOriginSchema = z.enum(['seed', 'user', 'managed']);

export const templateCapabilitiesSchema = z.object({
  canEdit: z.boolean(),
  canDelete: z.boolean(),
  canExport: z.boolean(),
  canApply: z.boolean(),
});

export const templateSummarySchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  title: z.string(),
  description: z.string().nullable(),
  origin: templateOriginSchema,
  revision: nonnegativeInt32Schema,
  includeBody: z.boolean(),
  includeChildren: z.boolean(),
  fieldCount: nonnegativeInt32Schema,
  viewCount: nonnegativeInt32Schema,
  childCount: nonnegativeInt32Schema,
  viewKinds: z.array(z.string()),
  capabilities: templateCapabilitiesSchema,
  updatedAt: z.iso.datetime({ offset: true }),
});

export type TemplateSummary = z.infer<typeof templateSummarySchema>;

const _templateSummaryContract = templateSummarySchema satisfies z.ZodType<TemplateSummaryContract>;
void _templateSummaryContract;

export const templateCatalogSchema = z.object({
  templates: z.array(templateSummarySchema),
  capabilities: z.object({ canManage: z.boolean() }),
});

export type TemplateCatalog = z.infer<typeof templateCatalogSchema>;

const _templateCatalogContract = templateCatalogSchema satisfies z.ZodType<TemplateCatalogContract>;
void _templateCatalogContract;

const templatePropertyDefinitionSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.string(),
  options: z.array(z.string()).default([]),
  required: z.boolean(),
});

const storedTemplateSchemaSchema = z.object({
  properties: z.array(templatePropertyDefinitionSchema),
  declared: z.array(templatePropertyDefinitionSchema).optional(),
  inherit: z.boolean().default(true),
});

export const templateEffectiveSchemaSchema = z.object({
  properties: z.array(templatePropertyDefinitionSchema),
  declared: z.array(templatePropertyDefinitionSchema),
  inherit: z.boolean(),
});

const templateFormConditionSchema = z.object({
  fieldBlockId: z.string(),
  operator: z.string(),
  value: z.string().nullable(),
});

const templateFormBlockSchema = z.object({
  id: z.string(),
  kind: z.string(),
  propertyKey: z.string().nullable(),
  text: z.string(),
  help: z.string().nullable(),
  required: z.boolean(),
  identityRole: z.string().nullable(),
  visibleWhen: z.array(templateFormConditionSchema),
});

const templateFormPageSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  visibleWhen: z.array(templateFormConditionSchema),
  blocks: z.array(templateFormBlockSchema),
});

const templateInteractiveFormSchema = z.object({
  pages: z.array(templateFormPageSchema),
  titleMode: z.string(),
  titleFieldBlockId: z.string().nullable(),
  confirmationTitle: z.string(),
  confirmationMessage: z.string(),
});

const templateViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  columns: z.array(z.string()).default([]),
  groupBy: z.string().nullable().default(null),
  groupOrder: z.array(z.string()).default([]),
  dateProperty: z.string().nullable().default(null),
  sortBy: z.string().nullable().default(null),
  sortDescending: z.boolean().default(false),
  mode: z.string().nullable().default(null),
  coverProperty: z.string().nullable().default(null),
  endDateProperty: z.string().nullable().default(null),
  cardSize: z.string().nullable().default(null),
  filters: z
    .array(
      z.object({
        property: z.string(),
        operator: z.string(),
        value: z.string(),
      }),
    )
    .default([]),
  companionViewId: z.string().nullable().default(null),
  companionPlacement: z.enum(['below', 'beside']).nullable().default(null),
  interactiveForm: templateInteractiveFormSchema.nullable().default(null),
});

const templateViewsSchema = z.object({
  views: z.array(templateViewSchema),
  default: z
    .string()
    .nullable()
    .default(null)
    .transform((value) => value ?? 'document'),
});

const storedTemplateItemFieldsSchema = z.object({
  sourceId: z.uuid(),
  itemType: z.string(),
  title: z.string(),
  seq: z.union([z.int(), z.string().regex(/^-?\d+$/)]).transform(String),
  properties: z.record(z.string(), z.unknown()).nullable().default(null),
  schema: storedTemplateSchemaSchema.nullable().default(null),
  views: templateViewsSchema.nullable().default(null),
  hasBody: z.boolean(),
});

type StoredTemplateItemFields = z.infer<typeof storedTemplateItemFieldsSchema>;
type StoredTemplateItem = StoredTemplateItemFields & {
  children: StoredTemplateItem[];
};

const storedTemplateItemSchema: z.ZodType<StoredTemplateItem> =
  storedTemplateItemFieldsSchema.extend({
    children: z.lazy(() => z.array(storedTemplateItemSchema)),
  });

type TemplateEffectiveSchema = z.infer<typeof templateEffectiveSchemaSchema>;
type TemplateViews = z.infer<typeof templateViewsSchema>;

export type TemplateItem = Omit<StoredTemplateItemFields, 'schema' | 'views'> & {
  schema: TemplateEffectiveSchema | null;
  views: TemplateViews | null;
  children: TemplateItem[];
};

function mergeProperties(
  farther: readonly z.infer<typeof templatePropertyDefinitionSchema>[],
  nearer: readonly z.infer<typeof templatePropertyDefinitionSchema>[],
): readonly z.infer<typeof templatePropertyDefinitionSchema>[] {
  const replacements = new Map(nearer.map((property) => [property.key, property]));
  const inheritedKeys = new Set(farther.map((property) => property.key));
  return [
    ...farther.map((property) => replacements.get(property.key) ?? property),
    ...nearer.filter((property) => !inheritedKeys.has(property.key)),
  ];
}

function normalizeTemplateItem(
  item: StoredTemplateItem,
  inherited: readonly z.infer<typeof templatePropertyDefinitionSchema>[] = [],
): TemplateItem {
  const declared = item.schema?.declared ?? item.schema?.properties ?? [];
  const effective =
    item.schema?.declared !== undefined
      ? item.schema.properties
      : item.schema?.inherit === false
        ? declared
        : mergeProperties(inherited, declared);
  const schema =
    item.schema === null
      ? inherited.length === 0
        ? null
        : { properties: [...inherited], declared: [], inherit: true }
      : { properties: [...effective], declared, inherit: item.schema.inherit };

  return {
    ...item,
    schema,
    children: item.children.map((child) => normalizeTemplateItem(child, schema?.properties ?? [])),
  };
}

export const templateItemSchema: z.ZodType<TemplateItem> = storedTemplateItemSchema.transform(
  (item) => normalizeTemplateItem(item),
);

const _templateItemContract = templateItemSchema satisfies z.ZodType<TemplateItemContract>;
void _templateItemContract;

export const templateDetailSchema = templateSummarySchema.extend({ root: templateItemSchema });
export type TemplateDetail = z.infer<typeof templateDetailSchema>;

const _templateDetailContract = templateDetailSchema satisfies z.ZodType<TemplateDetailContract>;
void _templateDetailContract;

/** The form accepts omitted nullable values; the wire schema normalizes them to explicit nulls. */
export const templatePreflightInputSchema = z.object({
  mode: z.enum(['merge', 'create']),
  targetItemId: z.uuid().nullable().optional(),
  parentItemId: z.uuid().nullable().optional(),
  title: z.string().nullable().optional(),
});

export type TemplatePreflightInput = z.infer<typeof templatePreflightInputSchema>;

export const templatePreflightRequestSchema = templatePreflightInputSchema.transform((input) => ({
  mode: input.mode,
  targetItemId: input.targetItemId ?? null,
  parentItemId: input.parentItemId ?? null,
  title: input.title ?? null,
}));

const _templatePreflightRequestContract =
  templatePreflightRequestSchema satisfies z.ZodType<TemplatePreflightRequestContract>;
void _templatePreflightRequestContract;

export const templatePreflightSchema = z.object({
  templateId: z.uuid(),
  mode: z.enum(['merge', 'create']),
  additions: z.object({
    fields: nonnegativeInt32Schema,
    views: nonnegativeInt32Schema,
    items: nonnegativeInt32Schema,
  }),
  conflicts: z.array(z.string()),
  canApply: z.boolean(),
});

export type TemplatePreflight = z.infer<typeof templatePreflightSchema>;

const _templatePreflightContract =
  templatePreflightSchema satisfies z.ZodType<TemplatePreflightContract>;
void _templatePreflightContract;
