/** The sites resource: the only place site URLs appear (ADR-0063). */

import type { NixClient } from '../client.js';
import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import { noContentSchema } from '../schemas/index.js';
import {
  siteBuildListSchema,
  siteBuildSchema,
  siteListSchema,
  sitePageListSchema,
  sitePageSchema,
  siteSchema,
  siteApprovalEntrySchema,
  siteApprovalListSchema,
  siteOperatorListSchema,
  type Site,
  type SiteApprovalEntry,
  type SiteApprovalList,
  type SiteOperatorList,
  type SiteServeMode,
  type SiteBuild,
  type SiteBuildList,
  type SiteBuildStatus,
  type SiteDatedCollection,
  type SiteLayout,
  type SiteList,
  type SitePage,
  type SitePageList,
  type SiteRepublishMode,
  type SiteSettings,
} from '../schemas/sites.js';

const siteKey = (siteId: string) => ['sites', siteId] as const;
const itemSiteKey = (itemId: string) => ['items', itemId, 'site'] as const;

export interface CreateSiteInput {
  readonly rootItemId: string;
  readonly slug: string;
  readonly layout: SiteLayout;
  readonly settings?: SiteSettings | null;
}

/** A field left out is left alone. */
export interface UpdateSiteInput {
  readonly settings?: SiteSettings;
  readonly layout?: SiteLayout;
  readonly republishMode?: SiteRepublishMode;
  readonly debounceSeconds?: number;
  readonly excludedItemIds?: readonly string[];
  readonly datedCollections?: readonly SiteDatedCollection[];
}

export interface PublishSiteInput {
  readonly idempotencyKey: string;
  readonly refreshPaths?: boolean;
  readonly acknowledgeDisclosure?: boolean;
}

/** The site rooted at an item. Core answers `sites.not_found` when the item has none. */
export const getItemSite = (itemId: string): QueryEndpoint<Site> =>
  defineQuery({
    operation: 'sites.getForItem',
    path: `/api/v1/items/${itemId}/site`,
    schema: siteSchema,
    cacheKey: itemSiteKey(itemId),
    staleAfterMs: 0,
  });

export const listWorkspaceSites = (workspaceId: string): QueryEndpoint<SiteList> =>
  defineQuery({
    operation: 'sites.listForWorkspace',
    path: `/api/v1/workspaces/${workspaceId}/sites`,
    schema: siteListSchema,
    cacheKey: ['workspaces', workspaceId, 'sites'],
    staleAfterMs: 0,
  });

export const getSite = (siteId: string): QueryEndpoint<Site> =>
  defineQuery({
    operation: 'sites.get',
    path: `/api/v1/sites/${siteId}`,
    schema: siteSchema,
    cacheKey: siteKey(siteId),
    staleAfterMs: 0,
  });

export const createSite = (input: CreateSiteInput): CommandEndpoint<Site> =>
  defineCommand({
    operation: 'sites.create',
    method: 'POST',
    path: '/api/v1/sites',
    body: { ...input, settings: input.settings ?? null },
    schema: siteSchema,
    invalidates: [itemSiteKey(input.rootItemId)],
  });

export const updateSite = (siteId: string, input: UpdateSiteInput): CommandEndpoint<Site> =>
  defineCommand({
    operation: 'sites.update',
    method: 'PATCH',
    path: `/api/v1/sites/${siteId}`,
    body: {
      settings: input.settings ?? null,
      layout: input.layout ?? null,
      republishMode: input.republishMode ?? null,
      debounceSeconds: input.debounceSeconds ?? null,
      excludedItemIds: input.excludedItemIds ?? null,
      datedCollections: input.datedCollections ?? null,
    },
    schema: siteSchema,
    invalidates: [siteKey(siteId)],
  });

export const setSiteHostnames = (
  siteId: string,
  hostnames: readonly string[],
): CommandEndpoint<Site> =>
  defineCommand({
    operation: 'sites.setHostnames',
    method: 'PUT',
    path: `/api/v1/sites/${siteId}/hostnames`,
    body: { hostnames },
    schema: siteSchema,
    invalidates: [siteKey(siteId)],
  });

const hostPath = (siteId: string, hostname: string) =>
  `/api/v1/sites/${siteId}/hostnames/${encodeURIComponent(hostname)}`;

/** Attaches a custom hostname; the response lists the DNS records to create. */
export const addSiteHostname = (
  siteId: string,
  hostname: string,
  serveMode?: SiteServeMode,
): CommandEndpoint<Site> =>
  defineCommand({
    operation: 'sites.hostnames.add',
    method: 'POST',
    path: `/api/v1/sites/${siteId}/hostnames`,
    body: { hostname, serveMode: serveMode ?? null },
    schema: siteSchema,
    invalidates: [siteKey(siteId)],
  });

export const removeSiteHostname = (siteId: string, hostname: string): CommandEndpoint<Site> =>
  defineCommand({
    operation: 'sites.hostnames.remove',
    method: 'DELETE',
    path: hostPath(siteId, hostname),
    schema: siteSchema,
    invalidates: [siteKey(siteId)],
  });

/** A field left out is left alone. */
export interface UpdateSiteHostnameInput {
  readonly serveMode?: SiteServeMode;
  readonly primary?: boolean;
}

export const updateSiteHostname = (
  siteId: string,
  hostname: string,
  input: UpdateSiteHostnameInput,
): CommandEndpoint<Site> =>
  defineCommand({
    operation: 'sites.hostnames.update',
    method: 'PATCH',
    path: hostPath(siteId, hostname),
    body: { serveMode: input.serveMode ?? null, primary: input.primary ?? null },
    schema: siteSchema,
    invalidates: [siteKey(siteId)],
  });

/** Core looks the records up itself; nothing the client reports is trusted. */
export const verifySiteHostname = (siteId: string, hostname: string): CommandEndpoint<Site> =>
  defineCommand({
    operation: 'sites.hostnames.verify',
    method: 'POST',
    path: `${hostPath(siteId, hostname)}/verify`,
    schema: siteSchema,
    invalidates: [siteKey(siteId)],
  });

/** Asks the operator to approve the first publish (deployments with `RequireOperatorApproval`). */
export const requestSiteApproval = (
  siteId: string,
  acknowledgeDisclosure: boolean,
): CommandEndpoint<Site> =>
  defineCommand({
    operation: 'sites.approval.request',
    method: 'POST',
    path: `/api/v1/sites/${siteId}/approval`,
    body: { acknowledgeDisclosure },
    schema: siteSchema,
    invalidates: [siteKey(siteId)],
  });

export const listSiteApprovals = (): QueryEndpoint<SiteApprovalList> =>
  defineQuery({
    operation: 'sites.approvals.list',
    path: '/api/v1/sites/approvals',
    schema: siteApprovalListSchema,
    cacheKey: ['sites', 'approvals'],
    staleAfterMs: 0,
  });

export const approveSitePublish = (siteId: string): CommandEndpoint<SiteApprovalEntry> =>
  defineCommand({
    operation: 'sites.approval.approve',
    method: 'POST',
    path: `/api/v1/sites/${siteId}/approval/approve`,
    schema: siteApprovalEntrySchema,
    invalidates: [siteKey(siteId), ['sites', 'approvals']],
  });

export const rejectSitePublish = (
  siteId: string,
  note?: string,
): CommandEndpoint<SiteApprovalEntry> =>
  defineCommand({
    operation: 'sites.approval.reject',
    method: 'POST',
    path: `/api/v1/sites/${siteId}/approval/reject`,
    body: { note: note ?? null },
    schema: siteApprovalEntrySchema,
    invalidates: [siteKey(siteId), ['sites', 'approvals']],
  });

const operatorsKey = ['sites', 'operators'] as const;

/** Who may approve first publishes: configured operators first, then those granted in Settings. */
export const listSiteOperators = (): QueryEndpoint<SiteOperatorList> =>
  defineQuery({
    operation: 'sites.operators.list',
    path: '/api/v1/sites/operators',
    schema: siteOperatorListSchema,
    cacheKey: operatorsKey,
    staleAfterMs: 0,
  });

export const grantSiteOperator = (principalId: string): CommandEndpoint<undefined> =>
  defineCommand({
    operation: 'sites.operators.grant',
    method: 'PUT',
    path: `/api/v1/sites/operators/${principalId}`,
    schema: noContentSchema,
    invalidates: [operatorsKey],
  });

/** Refused with 409 `sites.operator_configured` for an operator set in configuration. */
export const revokeSiteOperator = (principalId: string): CommandEndpoint<undefined> =>
  defineCommand({
    operation: 'sites.operators.revoke',
    method: 'DELETE',
    path: `/api/v1/sites/operators/${principalId}`,
    schema: noContentSchema,
    invalidates: [operatorsKey],
  });

export const publishSite = (siteId: string, input: PublishSiteInput): CommandEndpoint<SiteBuild> =>
  defineCommand({
    operation: 'sites.publish',
    method: 'POST',
    path: `/api/v1/sites/${siteId}/publish`,
    body: {
      idempotencyKey: input.idempotencyKey,
      refreshPaths: input.refreshPaths ?? false,
      acknowledgeDisclosure: input.acknowledgeDisclosure ?? false,
    },
    schema: siteBuildSchema,
    invalidates: [siteKey(siteId)],
  });

export const rollbackSite = (siteId: string, buildId: string): CommandEndpoint<SiteBuild> =>
  defineCommand({
    operation: 'sites.rollback',
    method: 'POST',
    path: `/api/v1/sites/${siteId}/rollback`,
    body: { buildId },
    schema: siteBuildSchema,
    invalidates: [siteKey(siteId)],
  });

export const unpublishSite = (siteId: string): CommandEndpoint<Site> =>
  defineCommand({
    operation: 'sites.unpublish',
    method: 'POST',
    path: `/api/v1/sites/${siteId}/unpublish`,
    schema: siteSchema,
    invalidates: [siteKey(siteId)],
  });

export const deleteSite = (siteId: string, rootItemId?: string): CommandEndpoint<undefined> =>
  defineCommand({
    operation: 'sites.delete',
    method: 'DELETE',
    path: `/api/v1/sites/${siteId}`,
    schema: noContentSchema,
    invalidates:
      rootItemId === undefined ? [siteKey(siteId)] : [siteKey(siteId), itemSiteKey(rootItemId)],
  });

export const listSiteBuilds = (siteId: string): QueryEndpoint<SiteBuildList> =>
  defineQuery({
    operation: 'sites.builds.list',
    path: `/api/v1/sites/${siteId}/builds`,
    schema: siteBuildListSchema,
    cacheKey: [...siteKey(siteId), 'builds'],
    staleAfterMs: 0,
  });

export const getSiteBuild = (siteId: string, buildId: string): QueryEndpoint<SiteBuild> =>
  defineQuery({
    operation: 'sites.builds.get',
    path: `/api/v1/sites/${siteId}/builds/${buildId}`,
    schema: siteBuildSchema,
    cacheKey: [...siteKey(siteId), 'builds', buildId],
    staleAfterMs: 0,
  });

export const listSitePages = (siteId: string): QueryEndpoint<SitePageList> =>
  defineQuery({
    operation: 'sites.pages.list',
    path: `/api/v1/sites/${siteId}/pages`,
    schema: sitePageListSchema,
    cacheKey: [...siteKey(siteId), 'pages'],
    staleAfterMs: 0,
  });

export const setSitePagePath = (
  siteId: string,
  itemId: string,
  path: string,
): CommandEndpoint<SitePage> =>
  defineCommand({
    operation: 'sites.pages.setPath',
    method: 'PUT',
    path: `/api/v1/sites/${siteId}/pages/${itemId}/path`,
    body: { path },
    schema: sitePageSchema,
    invalidates: [siteKey(siteId)],
  });

/** Whether a build is still on its way to being served or refused. */
export function isBuildSettling(status: SiteBuildStatus): boolean {
  return status === 'queued' || status === 'building' || status === 'sealed';
}

/**
 * Polls a build until it is no longer settling (live, failed, superseded or purged), backing off
 * from `initialDelayMs` to `maxDelayMs`. Throws when `timeoutMs` passes first.
 */
export async function waitForBuild(
  client: NixClient,
  initial: SiteBuild,
  options: {
    readonly signal?: AbortSignal;
    readonly initialDelayMs?: number;
    readonly maxDelayMs?: number;
    readonly timeoutMs?: number;
    readonly onProgress?: (build: SiteBuild) => void;
  } = {},
): Promise<SiteBuild> {
  const maxDelayMs = options.maxDelayMs ?? 2_000;
  let delayMs = Math.min(options.initialDelayMs ?? 250, maxDelayMs);
  const deadline = options.timeoutMs === undefined ? null : Date.now() + options.timeoutMs;
  let build = initial;
  options.onProgress?.(build);

  while (isBuildSettling(build.status)) {
    options.signal?.throwIfAborted();
    if (deadline !== null && Date.now() >= deadline) {
      throw new Error(`The build was still ${build.status} when the wait ran out.`);
    }
    await delay(delayMs, options.signal);
    delayMs = Math.min(delayMs * 2, maxDelayMs);
    build = await client.query(getSiteBuild(build.siteId, build.id), {
      signal: options.signal,
      forceRefresh: true,
    });
    options.onProgress?.(build);
  }
  return build;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(finish, milliseconds);
    signal?.addEventListener('abort', cancelWait, { once: true });

    function finish(): void {
      signal?.removeEventListener('abort', cancelWait);
      resolve();
    }

    function cancelWait(): void {
      globalThis.clearTimeout(timer);
      const reason = signal?.reason as unknown;
      reject(reason instanceof Error ? reason : new Error('The build wait was cancelled.'));
    }
  });
}
