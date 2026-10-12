import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { createLossReport, type ItemBody, type LossEntry } from '@nix/export';

import { renderFeed } from './feeds.js';
import { escapeHtml } from './html/escape.js';
import type { PublishedDownload } from './downloads.js';
import { notice, renderProse, type ProseAsset, type ProseDownload } from './html/prose.js';
import { renderViewHtml } from './html/views.js';
import type { StrippedImage } from './images.js';
import {
  SiteManifestError,
  publishedPages,
  type SiteBuildManifest,
  type SitePage,
} from './manifest.js';
import { buildSearchIndex } from './search.js';
import type { SiteModel, SiteNode } from './site-model.js';
import { renderRobots, renderSitemap } from './sitemap.js';
import { CLIENT_JS } from './theme/client.js';
import { THEME_FONTS, themeCss } from './theme/css.js';
import { renderBlogPages } from './theme/layout-blog.js';
import { renderDocsPages } from './theme/layout-docs.js';
import { renderShell } from './theme/shell.js';
import { glyph } from './theme/parts.js';

/**
 * A whole site, rendered: every file a build writes, in a stable order.
 *
 * **Deterministic.** The same input always produces the same bytes: files are sorted by path,
 * the only clock is the manifest's `builtAt`, dates are formatted without a locale, and theme
 * files are content-addressed. That is what lets a rebuild of an unchanged site upload nothing
 * new and lets the golden tests compare output byte for byte.
 *
 * Pure apart from reading the theme's font files from `@fontsource/nunito-sans`.
 */

export interface RenderSiteInput {
  readonly manifest: SiteBuildManifest;
  /** Parsed by `parseSitePages`, so paths, parents and the root are already checked. */
  readonly pages: readonly SitePage[];
  /** Each page's body; null or absent for a page with none. */
  readonly bodies: ReadonlyMap<string, ItemBody | null>;
  /** Images already stripped of metadata, by file item. */
  readonly assets: ReadonlyMap<string, StrippedImage>;
  /** Attached PDF, text and CSV files, by file item; absent for none. */
  readonly downloads?: ReadonlyMap<string, PublishedDownload>;
}

export interface RenderedFile {
  /** Relative to the build prefix (`build`) or the site's asset prefix's parent (`asset`). */
  readonly path: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly kind: 'build' | 'asset';
}

export interface RenderedSite {
  readonly files: readonly RenderedFile[];
  readonly loss: readonly LossEntry[];
}

const encoder = new TextEncoder();
const require = createRequire(import.meta.url);

let fontCache: readonly { readonly file: string; readonly bytes: Uint8Array }[] | null = null;

function fonts(): readonly { readonly file: string; readonly bytes: Uint8Array }[] {
  fontCache ??= THEME_FONTS.map((font) => ({
    file: font.file,
    bytes: new Uint8Array(
      readFileSync(require.resolve(`@fontsource/nunito-sans/files/${font.file}`)),
    ),
  }));
  return fontCache;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** `84 KB`, `1.2 MB`: binary units, one decimal place under ten. */
export function formatBytes(bytes: number): string {
  const units = ['bytes', 'KB', 'MB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown = unit === 0 || value >= 10 ? String(Math.round(value)) : value.toFixed(1);
  return `${shown} ${units[unit] ?? ''}`;
}

function htmlPath(path: string): string {
  return `${path.slice(1)}index.html`;
}

function buildTree(
  manifest: SiteBuildManifest,
  pages: readonly SitePage[],
): {
  nodes: SiteNode[];
  byItem: Map<string, SiteNode>;
} {
  const collections = new Map(manifest.datedCollections.map((entry) => [entry.itemId, entry]));
  const byItem = new Map<string, SiteNode>();
  const nodes: SiteNode[] = [];
  // Pages arrive in pre-order (parents first), which `parseSitePages` sorted by ordinal.
  for (const page of pages) {
    const parent = page.parentItemId === null ? null : (byItem.get(page.parentItemId) ?? null);
    if (page.parentItemId !== null && parent === null) {
      throw new SiteManifestError('A page is listed before its parent.');
    }
    const node: SiteNode = {
      page,
      parent,
      children: [],
      depth: parent === null ? 0 : parent.depth + 1,
      prose: null,
      viewHtml: '',
      collection: collections.get(page.itemId) ?? null,
    };
    parent?.children.push(node);
    byItem.set(page.itemId, node);
    nodes.push(node);
  }
  return { nodes, byItem };
}

export function renderSite(input: RenderSiteInput): RenderedSite {
  const { manifest } = input;
  const report = createLossReport();
  const { nodes, byItem } = buildTree(manifest, publishedPages(input.pages));
  const root = byItem.get(manifest.rootItemId);
  if (root === undefined) {
    throw new SiteManifestError('The root item is not among the pages.');
  }

  const usedAssets = new Set<string>();
  const asset = (fileItemId: string): ProseAsset | null => {
    const image = input.assets.get(fileItemId);
    if (image === undefined) {
      return null;
    }
    usedAssets.add(fileItemId);
    return {
      url: `/_nix/assets/${image.sha256}.${image.ext}`,
      width: image.width,
      height: image.height,
    };
  };

  // One copy per content digest, named after the first file item (by id) that holds it, so the
  // output does not depend on the order pages reference it.
  const downloads = input.downloads ?? new Map<string, PublishedDownload>();
  const downloadPaths = new Map<string, string>();
  for (const id of [...downloads.keys()].sort()) {
    const file = downloads.get(id);
    if (file !== undefined && !downloadPaths.has(file.sha256)) {
      downloadPaths.set(file.sha256, `_nix/files/${file.sha256}/${file.fileName}`);
    }
  }
  const usedDownloads = new Set<string>();
  const download = (fileItemId: string): ProseDownload | null => {
    const file = downloads.get(fileItemId);
    const path = file === undefined ? undefined : downloadPaths.get(file.sha256);
    if (file === undefined || path === undefined) {
      return null;
    }
    usedDownloads.add(path);
    return {
      url: `/${path}`,
      name: path.slice(path.lastIndexOf('/') + 1),
      label: `${file.ext.toUpperCase()}, ${formatBytes(file.bytes.length)}`,
    };
  };

  const diagram = (fileItemId: string, sourceSha256: string): ProseAsset | null =>
    input.assets.get(fileItemId)?.sourceSha256 === sourceSha256 ? asset(fileItemId) : null;

  // Theme files, addressed by their content so a changed theme never meets a cached old one.
  const css = themeCss(manifest.settings.accent);
  const themeHash = sha256(
    [css, CLIENT_JS, ...fonts().map((font) => `${font.file}:${sha256(font.bytes)}`)].join('\n'),
  ).slice(0, 16);
  const themeDir = `_nix/theme/${themeHash}/`;

  const model: SiteModel = {
    manifest,
    root,
    nodes,
    byItem,
    theme: { css: `/${themeDir}site.css`, js: `/${themeDir}site.js` },
    asset,
    download,
  };

  const context = {
    pathOf: (itemId: string) => byItem.get(itemId)?.page.path ?? null,
    titleOf: (itemId: string) => byItem.get(itemId)?.page.title ?? null,
    asset,
    diagram,
    download,
  };

  for (const node of nodes) {
    const body = input.bodies.get(node.page.itemId) ?? null;
    if (body !== null && 'prosemirror' in body) {
      node.prose = renderProse(body.prosemirror, node.page.itemId, report, context);
    } else if (body !== null) {
      report
        .for(node.page.itemId)
        .note('body-not-rendered', 'A sheet or canvas body cannot be shown on a static page yet.');
      node.prose = {
        html: notice('This page is a sheet or a canvas, which a published site cannot show yet.'),
        headings: [],
        text: '',
        summary: '',
      };
    }
  }
  for (const node of nodes) {
    if (node.collection === null) {
      node.viewHtml = renderViewHtml(model, node, report.for(node.page.itemId));
    }
  }

  const pages = manifest.layout === 'docs' ? renderDocsPages(model) : renderBlogPages(model);
  const files: RenderedFile[] = [];
  const add = (
    path: string,
    mediaType: string,
    content: string | Uint8Array,
    kind: RenderedFile['kind'] = 'build',
  ) => {
    files.push({
      path,
      mediaType,
      bytes: typeof content === 'string' ? encoder.encode(content) : content,
      kind,
    });
  };

  for (const [path, html] of pages) {
    add(htmlPath(path), 'text/html; charset=utf-8', html);
  }

  add(
    '404.html',
    'text/html; charset=utf-8',
    renderShell(model, {
      path: '/404.html',
      title: 'Page not found',
      description: '',
      kind: 'website',
      image: null,
      notFound: true,
      body: `<section class="nix-hero nix-404"><p class="nix-eyebrow">${glyph(true)}<span>404</span></p><h1 class="nix-hero-title">This page is not here.</h1><p class="nix-hero-lead">It may have moved, or it was never published. Start again from <a href="/">${escapeHtml(model.root.page.title)}</a>.</p></section>`,
    }),
  );

  for (const node of nodes) {
    if (node.collection !== null) {
      add(
        `${node.page.path.slice(1)}feed.xml`,
        'application/atom+xml; charset=utf-8',
        renderFeed(model, node),
      );
    }
  }
  add('sitemap.xml', 'application/xml; charset=utf-8', renderSitemap(model, [...pages.keys()]));
  add('robots.txt', 'text/plain; charset=utf-8', renderRobots(model));

  const search = buildSearchIndex(
    nodes.map((node) => ({
      path: node.page.path,
      title: node.page.title,
      text: [
        node.prose?.text ?? '',
        ...(node.prose?.headings.map((heading) => heading.text) ?? []),
      ].join(' '),
    })),
  );
  if (search.partial) {
    report
      .for(manifest.rootItemId)
      .note(
        'view-rows-truncated',
        'The search index grew past its limit, so it covers page titles only.',
      );
  }
  add('_nix/search.json', 'application/json', search.json);

  const redirects: Record<string, string> = {};
  for (const redirect of [...manifest.redirects].sort((a, b) => a.from.localeCompare(b.from))) {
    const target = byItem.get(redirect.toItemId);
    if (target !== undefined) {
      redirects[redirect.from] = target.page.path;
    }
  }
  add('_nix/redirects.json', 'application/json', JSON.stringify(redirects));

  add(`${themeDir}site.css`, 'text/css; charset=utf-8', css);
  add(`${themeDir}site.js`, 'text/javascript; charset=utf-8', CLIENT_JS);
  for (const font of fonts()) {
    add(`${themeDir}fonts/${font.file}`, 'font/woff2', font.bytes);
  }

  // Two file items holding the same picture share one content-addressed copy.
  const assetPaths = new Set<string>();
  for (const fileItemId of [...usedAssets].sort()) {
    const image = input.assets.get(fileItemId);
    const path = image === undefined ? null : `_nix/assets/${image.sha256}.${image.ext}`;
    if (image !== undefined && path !== null && !assetPaths.has(path)) {
      assetPaths.add(path);
      add(path, image.mediaType, image.bytes, 'asset');
    }
  }

  const byPath = new Map([...downloads.values()].map((file) => [file.sha256, file]));
  for (const path of [...usedDownloads].sort()) {
    const file = byPath.get(path.split('/')[2] ?? '');
    if (file !== undefined) {
      add(path, file.mediaType, file.bytes, 'asset');
    }
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const index = files.map((file) => ({
    path: file.path,
    kind: file.kind,
    sha256: sha256(file.bytes),
    bytes: file.bytes.length,
  }));
  add(
    '_nix/build.json',
    'application/json',
    JSON.stringify({ buildId: manifest.buildId, builtAt: manifest.builtAt, files: index }),
  );
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return { files, loss: report.entries() };
}
