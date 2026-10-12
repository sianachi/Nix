import { z } from 'zod';
import type { components } from '../generated/api.js';

/** An integer the contract may spell as a number or a digit string; parsed to a number. */
const countSchema = z
  .union([z.number().int().nonnegative(), z.string().regex(/^(?:0|[1-9]\d*)$/)])
  .transform(Number);
const instantSchema = z.iso.datetime({ offset: true });

export const siteLayoutSchema = z.enum(['docs', 'blog']);
export const siteStatusSchema = z.enum(['draft', 'published', 'unpublished']);
export const siteRepublishModeSchema = z.enum(['manual', 'auto', 'on_release']);
export const siteBuildStatusSchema = z.enum([
  'queued',
  'building',
  'sealed',
  'live',
  'superseded',
  'failed',
  'purged',
]);

export const siteNavLinkSchema = z.object({
  label: z.string(),
  path: z.string(),
});

export const siteSettingsSchema = z.object({
  name: z.string(),
  description: z.string(),
  accent: z.string(),
  navigation: z.array(siteNavLinkSchema),
  footerText: z.string(),
  builtWithNix: z.boolean(),
  language: z.string(),
});

export const siteDatedCollectionSchema = z.object({
  itemId: z.uuid(),
  dateProperty: z.string().min(1),
  tagsProperty: z.string().nullable(),
  coverProperty: z.string().nullable(),
  summaryProperty: z.string().nullable(),
});

export const siteServeModeSchema = z.enum(['serve', 'redirect']);
export const siteHostnameStatusSchema = z.enum(['verified', 'failing', 'pending', 'checking']);

export const siteDnsRecordSchema = z.object({
  type: z.enum(['TXT', 'CNAME']),
  name: z.string(),
  value: z.string(),
  purpose: z.enum(['verification', 'routing']),
});

export const siteHostnameSchema = z.object({
  hostname: z.string().min(1),
  url: z.url(),
  kind: z.enum(['default', 'custom']),
  verified: z.boolean(),
  primary: z.boolean(),
  serveMode: siteServeModeSchema,
  status: siteHostnameStatusSchema,
  checkedAt: instantSchema.nullable(),
  checkError: z.string().nullable(),
  managed: z.boolean(),
  records: z.array(siteDnsRecordSchema),
});

export const siteApprovalSchema = z.object({
  state: z.enum(['pending', 'approved', 'rejected']),
  requestedAt: instantSchema,
  decidedAt: instantSchema.nullable(),
  note: z.string().nullable(),
});

export const siteBuildSchema = z.object({
  id: z.uuid(),
  siteId: z.uuid(),
  status: siteBuildStatusSchema,
  origin: z.string(),
  pageCount: countSchema,
  fileCount: countSchema,
  totalBytes: countSchema,
  loss: z.array(z.string()),
  failureCode: z.string().nullable(),
  createdAt: instantSchema,
  activatedAt: instantSchema.nullable(),
});

export const siteSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  rootItemId: z.uuid(),
  slug: z.string(),
  layout: siteLayoutSchema,
  settings: siteSettingsSchema,
  republishMode: siteRepublishModeSchema,
  debounceSeconds: countSchema,
  status: siteStatusSchema,
  canManage: z.boolean(),
  hostnames: z.array(siteHostnameSchema),
  excludedItemIds: z.array(z.uuid()),
  datedCollections: z.array(siteDatedCollectionSchema),
  liveBuild: siteBuildSchema.nullable(),
  latestBuild: siteBuildSchema.nullable(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
  primaryHostname: z.string().nullable(),
  approvalRequired: z.boolean(),
  approval: siteApprovalSchema.nullable(),
});

export const siteListSchema = z.object({ sites: z.array(siteSchema) });
export const siteBuildListSchema = z.object({ builds: z.array(siteBuildSchema) });

export const sitePageSchema = z.object({
  itemId: z.uuid(),
  path: z.string(),
  pinned: z.boolean(),
  title: z.string().nullable(),
});

export const sitePageListSchema = z.object({ pages: z.array(sitePageSchema) });

export const siteApprovalEntrySchema = z.object({
  siteId: z.uuid(),
  workspaceId: z.uuid(),
  slug: z.string(),
  name: z.string(),
  hostnames: z.array(z.string()),
  requestedBy: z.uuid(),
  approval: siteApprovalSchema,
  build: siteBuildSchema.nullable(),
});

export const siteApprovalListSchema = z.object({ approvals: z.array(siteApprovalEntrySchema) });

export type SiteLayout = z.infer<typeof siteLayoutSchema>;
export type SiteStatus = z.infer<typeof siteStatusSchema>;
export type SiteRepublishMode = z.infer<typeof siteRepublishModeSchema>;
export type SiteBuildStatus = z.infer<typeof siteBuildStatusSchema>;
export type SiteNavLink = z.infer<typeof siteNavLinkSchema>;
export type SiteSettings = z.infer<typeof siteSettingsSchema>;
export type SiteDatedCollection = z.infer<typeof siteDatedCollectionSchema>;
export type SiteHostname = z.infer<typeof siteHostnameSchema>;
export type SiteServeMode = z.infer<typeof siteServeModeSchema>;
export type SiteDnsRecord = z.infer<typeof siteDnsRecordSchema>;
export type SiteApproval = z.infer<typeof siteApprovalSchema>;
export type SiteApprovalEntry = z.infer<typeof siteApprovalEntrySchema>;
export type SiteApprovalList = z.infer<typeof siteApprovalListSchema>;
export type SiteBuild = z.infer<typeof siteBuildSchema>;
export type Site = z.infer<typeof siteSchema>;
export type SiteList = z.infer<typeof siteListSchema>;
export type SiteBuildList = z.infer<typeof siteBuildListSchema>;
export type SitePage = z.infer<typeof sitePageSchema>;
export type SitePageList = z.infer<typeof sitePageListSchema>;

type Schemas = components['schemas'];
const _contracts = [
  siteSettingsSchema satisfies z.ZodType<Schemas['SiteSettingsDto']>,
  siteDatedCollectionSchema satisfies z.ZodType<Schemas['SiteDatedCollectionDto']>,
  siteHostnameSchema satisfies z.ZodType<Schemas['SiteHostnameResponse']>,
  siteBuildSchema satisfies z.ZodType<Schemas['SiteBuildResponse']>,
  siteSchema satisfies z.ZodType<Schemas['SiteResponse']>,
  siteListSchema satisfies z.ZodType<Schemas['SiteListResponse']>,
  siteBuildListSchema satisfies z.ZodType<Schemas['SiteBuildListResponse']>,
  sitePageSchema satisfies z.ZodType<Schemas['SitePageResponse']>,
  sitePageListSchema satisfies z.ZodType<Schemas['SitePageListResponse']>,
  siteDnsRecordSchema satisfies z.ZodType<Schemas['SiteDnsRecordDto']>,
  siteApprovalSchema satisfies z.ZodType<Schemas['SiteApprovalDto']>,
  siteApprovalEntrySchema satisfies z.ZodType<Schemas['SiteApprovalResponse']>,
  siteApprovalListSchema satisfies z.ZodType<Schemas['SiteApprovalListResponse']>,
];
void _contracts;
