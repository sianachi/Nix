/**
 * `nixctl site`: publish an item's subtree as a static website (ADR-0063).
 *
 * Core decides everything: who may manage a site (workspace owners), what a build includes, and
 * which hostnames are served. These commands only ask. Anything that makes content public for the
 * first time, re-serves old content, or takes a site down needs `--yes`.
 */

import {
  sites,
  type Site,
  type SiteBuild,
  type SiteDatedCollection,
  type SiteLayout,
  type SiteRepublishMode,
  type UpdateSiteInput,
} from '@nix/api-client';
import { randomUUID } from 'node:crypto';
import { resolveSession, type SessionDeps } from './shared.ts';
import { printResult, type OutputOptions } from '../output.ts';

const LAYOUTS: readonly SiteLayout[] = ['docs', 'blog'];
const MODES: readonly SiteRepublishMode[] = ['manual', 'auto', 'on_release'];

function confirm(confirmed: boolean, what: string): void {
  if (!confirmed) throw new Error(`${what} Pass --yes to confirm.`);
}

function layoutOf(value: string): SiteLayout {
  const layout = LAYOUTS.find((candidate) => candidate === value);
  if (layout === undefined) throw new Error("Layout must be 'docs' or 'blog'.");
  return layout;
}

/**
 * Parses `<itemId>:<dateProperty>[:<tags>[:<cover>[:<summary>]]]`. An empty optional part means
 * none, so `id:date::cover` sets a cover without tags.
 */
export function parseDated(value: string): SiteDatedCollection {
  const [itemId = '', dateProperty = '', tags, cover, summary, ...rest] = value.split(':');
  if (itemId === '' || dateProperty === '' || rest.length > 0) {
    throw new Error(
      'A dated collection is <itemId>:<dateProperty>[:<tagsProperty>[:<coverProperty>[:<summaryProperty>]]].',
    );
  }
  const optional = (part: string | undefined): string | null =>
    part === undefined || part === '' ? null : part;
  return {
    itemId,
    dateProperty,
    tagsProperty: optional(tags),
    coverProperty: optional(cover),
    summaryProperty: optional(summary),
  };
}

/** The saved dated collections with `added` replacing any entry for the same item, less `removed`. */
export function mergeDated(
  current: readonly SiteDatedCollection[],
  added: readonly SiteDatedCollection[],
  removed: readonly string[],
): SiteDatedCollection[] {
  const replaced = new Set([...added.map((entry) => entry.itemId), ...removed]);
  return [...current.filter((entry) => !replaced.has(entry.itemId)), ...added];
}

export async function createSite(
  profileName: string | undefined,
  rootItemId: string,
  options: { readonly slug: string; readonly layout: string },
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const layout = layoutOf(options.layout);
  const session = await resolveSession(profileName, deps);
  const site = await session.client.execute(
    sites.createSite({ rootItemId, slug: options.slug, layout }),
  );
  printResult(site, output);
}

export async function getSite(
  profileName: string | undefined,
  target: { readonly siteId?: string | undefined; readonly itemId?: string | undefined },
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  if ((target.siteId === undefined) === (target.itemId === undefined)) {
    throw new Error('Name a site id, or pass --item <itemId>, but not both.');
  }
  const session = await resolveSession(profileName, deps);
  const site = await session.client.query(
    target.siteId === undefined
      ? sites.getItemSite(target.itemId ?? '')
      : sites.getSite(target.siteId),
    { forceRefresh: true },
  );
  printResult(site, output);
}

export interface UpdateSiteOptions {
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly accent?: string | undefined;
  readonly layout?: string | undefined;
  readonly mode?: string | undefined;
  readonly debounce?: string | undefined;
  readonly exclude?: readonly string[] | undefined;
  readonly dated?: readonly string[] | undefined;
  readonly undated?: readonly string[] | undefined;
  readonly yes?: boolean | undefined;
}

export async function updateSite(
  profileName: string | undefined,
  siteId: string,
  options: UpdateSiteOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  let republishMode: SiteRepublishMode | undefined;
  if (options.mode !== undefined) {
    republishMode = MODES.find((mode) => mode === options.mode);
    if (republishMode === undefined)
      throw new Error("Mode must be 'manual', 'auto' or 'on_release'.");
    if (republishMode === 'auto') {
      confirm(
        options.yes === true,
        'In auto mode every saved edit inside the site goes public on its own once it settles.',
      );
    }
  }
  const added = (options.dated ?? []).map(parseDated);
  const debounceSeconds = options.debounce === undefined ? undefined : Number(options.debounce);
  if (debounceSeconds !== undefined && !Number.isInteger(debounceSeconds)) {
    throw new Error('--debounce is a whole number of seconds.');
  }

  const session = await resolveSession(profileName, deps);
  const touchesSettings =
    options.name !== undefined || options.description !== undefined || options.accent !== undefined;
  const touchesDated = options.dated !== undefined || options.undated !== undefined;
  // Settings and dated collections are replaced whole, so a partial change starts from what Core
  // holds now.
  const current: Site | null =
    touchesSettings || touchesDated
      ? await session.client.query(sites.getSite(siteId), { forceRefresh: true })
      : null;
  const input: UpdateSiteInput = {
    ...(current === null || !touchesSettings
      ? {}
      : {
          settings: {
            ...current.settings,
            ...(options.name === undefined ? {} : { name: options.name }),
            ...(options.description === undefined ? {} : { description: options.description }),
            ...(options.accent === undefined ? {} : { accent: options.accent }),
          },
        }),
    ...(options.layout === undefined ? {} : { layout: layoutOf(options.layout) }),
    ...(republishMode === undefined ? {} : { republishMode }),
    ...(debounceSeconds === undefined ? {} : { debounceSeconds }),
    ...(options.exclude === undefined ? {} : { excludedItemIds: options.exclude }),
    ...(current === null || !touchesDated
      ? {}
      : { datedCollections: mergeDated(current.datedCollections, added, options.undated ?? []) }),
  };
  const site = await session.client.execute(sites.updateSite(siteId, input));
  printResult(site, output);
}

export interface PublishOptions {
  readonly refreshPaths?: boolean | undefined;
  readonly yes?: boolean | undefined;
  readonly wait?: boolean | undefined;
  /** How long `--wait` waits, in seconds. */
  readonly timeout?: string | undefined;
}

export async function publishSite(
  profileName: string | undefined,
  siteId: string,
  options: PublishOptions,
  output: OutputOptions,
  deps: SessionDeps & { readonly pollMs?: number } = {},
): Promise<void> {
  const timeoutSeconds = Number(options.timeout ?? '600');
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error('--timeout is a positive number of seconds.');
  }
  const session = await resolveSession(profileName, deps);
  const site = await session.client.query(sites.getSite(siteId), { forceRefresh: true });
  // A draft, or a site taken down earlier, becomes public again only with --yes.
  if (site.status !== 'published') {
    confirm(
      options.yes === true,
      'Publishing makes this content public. Search engines and archives may keep copies, and unpublishing cannot recall them.',
    );
  }
  const queued = await session.client.execute(
    sites.publishSite(siteId, {
      idempotencyKey: `nixctl-site-publish:${randomUUID()}`,
      refreshPaths: options.refreshPaths === true,
      acknowledgeDisclosure: options.yes === true,
    }),
  );
  if (options.wait !== true) {
    printResult(queued, output);
    return;
  }
  const settled: SiteBuild = await sites.waitForBuild(session.client, queued, {
    timeoutMs: timeoutSeconds * 1000,
    ...(deps.pollMs === undefined ? {} : { initialDelayMs: deps.pollMs, maxDelayMs: deps.pollMs }),
  });
  printResult(settled, output);
  if (settled.status !== 'live') {
    throw new Error(
      `The build ended ${settled.status}${settled.failureCode === null ? '' : ` (${settled.failureCode})`}.`,
    );
  }
}

export async function listBuilds(
  profileName: string | undefined,
  siteId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  printResult(await session.client.query(sites.listSiteBuilds(siteId)), output);
}

export async function getBuild(
  profileName: string | undefined,
  siteId: string,
  buildId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  printResult(await session.client.query(sites.getSiteBuild(siteId, buildId)), output);
}

export async function listPages(
  profileName: string | undefined,
  siteId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  printResult(await session.client.query(sites.listSitePages(siteId)), output);
}

export async function setPath(
  profileName: string | undefined,
  siteId: string,
  itemId: string,
  path: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  printResult(await session.client.execute(sites.setSitePagePath(siteId, itemId, path)), output);
}

export async function rollbackSite(
  profileName: string | undefined,
  siteId: string,
  buildId: string,
  confirmed: boolean,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  confirm(
    confirmed,
    'A rollback serves that build exactly as it was, including pages since locked, trashed or left out.',
  );
  const session = await resolveSession(profileName, deps);
  printResult(await session.client.execute(sites.rollbackSite(siteId, buildId)), output);
}

export async function unpublishSite(
  profileName: string | undefined,
  siteId: string,
  confirmed: boolean,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  confirm(confirmed, 'Unpublishing takes the site down and deletes its builds.');
  const session = await resolveSession(profileName, deps);
  printResult(await session.client.execute(sites.unpublishSite(siteId)), output);
}

export async function deleteSite(
  profileName: string | undefined,
  siteId: string,
  confirmed: boolean,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  confirm(confirmed, 'Deleting a site removes its settings and page paths.');
  const session = await resolveSession(profileName, deps);
  await session.client.execute(sites.deleteSite(siteId));
  printResult({ id: siteId, deleted: true }, output);
}
