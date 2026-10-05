import { z } from 'zod';

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const documentImportUploadSchema = z.object({
  id: z.uuid(),
  status: z.string(),
  uploadUrl: z.url().nullable(),
  capabilityExpiresAt: z.iso.datetime({ offset: true }).nullable(),
  expiresAt: z.iso.datetime({ offset: true }),
});

export const documentImportSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  uploadId: z.uuid(),
  parentId: z.uuid().nullable(),
  format: z.string(),
  title: z.string(),
  status: z.string(),
  previewOperationId: z.uuid().nullable(),
  commitOperationId: z.uuid().nullable(),
  itemCount: z.number().int().positive().nullable(),
  assetCount: z.number().int().nonnegative().nullable(),
  loss: z.array(z.string()).nullable(),
  omissions: z.array(z.string()).nullable(),
  rootItemId: z.uuid().nullable(),
  failureCode: z.string().nullable(),
  expiresAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
});

export const documentImportPreviewCapabilitySchema = z.object({
  url: z.url(),
  expiresAt: z.iso.datetime({ offset: true }),
  sha256: digestSchema,
  byteLength: z.number().int().positive(),
});

const importPlanFileSchema = z.object({
  sourceKind: z.enum(['source', 'asset']),
  assetPath: z.string().optional(),
  fileName: z.string(),
  mediaType: z.string(),
  byteLength: z.number().int().nonnegative(),
  sha256: digestSchema,
  previewable: z.boolean(),
  pixelWidth: z.number().int().positive().optional(),
  pixelHeight: z.number().int().positive().optional(),
});

export const documentImportPlanSchema = z.object({
  version: z.literal(1),
  format: z.string(),
  title: z.string(),
  sourceSha256: digestSchema,
  items: z
    .array(
      z.object({
        sourceId: z.string(),
        parentSourceId: z.string().nullable(),
        order: z.number().int().nonnegative(),
        title: z.string(),
        itemType: z.string(),
        finalLifecycleState: z.enum(['active', 'deleted']),
        body: z.unknown().optional(),
        file: importPlanFileSchema.optional(),
      }),
    )
    .min(1)
    .max(10_000),
  loss: z.array(z.string()),
  omissions: z.array(z.string()),
});

export type DocumentImport = z.infer<typeof documentImportSchema>;
export type DocumentImportPlan = z.infer<typeof documentImportPlanSchema>;
export type DocumentImportUpload = z.infer<typeof documentImportUploadSchema>;
