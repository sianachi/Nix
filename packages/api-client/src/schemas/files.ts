import { z } from 'zod';

export const fileVersionSchema = z.object({
  id: z.uuid(),
  version: z.number().int().positive(),
  fileName: z.string(),
  mediaType: z.string(),
  byteLength: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  previewable: z.boolean(),
  pixelWidth: z.number().int().positive().nullable(),
  pixelHeight: z.number().int().positive().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  current: z.boolean(),
});
export const fileRecordSchema = z.object({
  itemId: z.uuid(),
  workspaceId: z.uuid(),
  current: fileVersionSchema,
  versions: z.array(fileVersionSchema),
});
export const fileUploadSchema = z.object({
  id: z.uuid(),
  status: z.string(),
  uploadUrl: z.url().nullable(),
  capabilityExpiresAt: z.iso.datetime({ offset: true }).nullable(),
  expiresAt: z.iso.datetime({ offset: true }),
  itemId: z.uuid().nullable(),
  failureCode: z.string().nullable(),
});
export const fileUploadStatusSchema = z.object({
  id: z.uuid(),
  status: z.string(),
  expiresAt: z.iso.datetime({ offset: true }),
  itemId: z.uuid().nullable(),
  failureCode: z.string().nullable(),
});
export const fileDownloadCapabilitySchema = z.object({
  url: z.url(),
  expiresAt: z.iso.datetime({ offset: true }),
  fileName: z.string(),
  mediaType: z.string(),
  byteLength: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  inline: z.boolean(),
  unscanned: z.boolean(),
  noSniff: z.boolean(),
});
export type FileRecord = z.infer<typeof fileRecordSchema>;
export type FileVersion = z.infer<typeof fileVersionSchema>;
export type FileUpload = z.infer<typeof fileUploadSchema>;
export type FileUploadStatus = z.infer<typeof fileUploadStatusSchema>;
export type FileDownloadCapability = z.infer<typeof fileDownloadCapabilitySchema>;
