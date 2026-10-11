import { escapeHtml, safeHref } from '../html/escape.js';
import type { ProseAsset } from '../html/prose.js';
import type { SiteModel, SiteNode } from '../site-model.js';

/**
 * The document every page shares: head metadata, header, skip link, footer.
 *
 * Head carries the canonical URL, Open Graph and Twitter metadata (with the page's cover as the
 * preview image when it has one), and the Atom feeds. No inline script or style anywhere, so the
 * site's content security policy can forbid both.
 */

export const BUILT_WITH_NIX_URL = 'https://github.com/sianachi/nix';

export interface ShellPage {
  readonly path: string;
  readonly title: string;
  readonly description: string;
  readonly kind: 'website' | 'article';
  readonly image: ProseAsset | null;
  readonly publishedAt?: string | null;
  readonly current?: SiteNode | null;
  readonly body: string;
  readonly search?: boolean;
  /** For 404: no canonical link, and robots told not to index. */
  readonly notFound?: boolean;
}

export function absolute(model: SiteModel, path: string): string {
  return `${model.manifest.canonicalOrigin}${path}`;
}

function feedLinks(model: SiteModel): string {
  return model.nodes
    .filter((node) => node.collection !== null)
    .map(
      (node) =>
        `<link rel="alternate" type="application/atom+xml" title="${escapeHtml(`${model.manifest.settings.name}: ${node.page.title}`)}" href="${escapeHtml(`${node.page.path}feed.xml`)}">`,
    )
    .join('');
}

function navigation(model: SiteModel, current: SiteNode | null | undefined): string {
  const items = model.manifest.settings.navigation
    .map((entry) => {
      const href = safeHref(entry.path);
      if (href === null) {
        return '';
      }
      const active =
        current !== null &&
        current !== undefined &&
        href.startsWith('/') &&
        href !== '/' &&
        current.page.path.startsWith(href);
      return `<li><a href="${escapeHtml(href)}"${active ? ' aria-current="true"' : ''}>${escapeHtml(entry.label)}</a></li>`;
    })
    .join('');
  return items.length === 0 ? '' : `<nav class="nix-nav" aria-label="Site"><ul>${items}</ul></nav>`;
}

export function renderShell(model: SiteModel, page: ShellPage): string {
  const { settings, layout } = model.manifest;
  const name = settings.name;
  const fullTitle = page.path === '/' && page.title === name ? name : `${page.title} - ${name}`;
  const url = absolute(model, page.path);
  const description = page.description.length > 0 ? page.description : settings.description;
  const image = page.image === null ? null : absolute(model, page.image.url);

  const meta = [
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${escapeHtml(fullTitle)}</title>`,
    description.length > 0 ? `<meta name="description" content="${escapeHtml(description)}">` : '',
    page.notFound === true
      ? `<meta name="robots" content="noindex">`
      : `<link rel="canonical" href="${escapeHtml(url)}">`,
    `<meta name="generator" content="Nix">`,
    `<meta name="color-scheme" content="light dark">`,
    `<meta property="og:site_name" content="${escapeHtml(name)}">`,
    `<meta property="og:title" content="${escapeHtml(page.title)}">`,
    description.length > 0
      ? `<meta property="og:description" content="${escapeHtml(description)}">`
      : '',
    `<meta property="og:type" content="${page.kind}">`,
    page.notFound === true ? '' : `<meta property="og:url" content="${escapeHtml(url)}">`,
    image === null ? '' : `<meta property="og:image" content="${escapeHtml(image)}">`,
    page.publishedAt == null
      ? ''
      : `<meta property="article:published_time" content="${escapeHtml(page.publishedAt)}">`,
    `<meta name="twitter:card" content="${image === null ? 'summary' : 'summary_large_image'}">`,
    `<link rel="stylesheet" href="${model.theme.css}">`,
    `<script src="${model.theme.js}"></script>`,
    feedLinks(model),
  ]
    .filter((line) => line.length > 0)
    .join('\n');

  const search =
    page.search === true
      ? `<div class="nix-search" data-nix-search="/_nix/search.json" role="search" hidden><label class="sr-only" for="nix-search-input">Search ${escapeHtml(name)}</label><input id="nix-search-input" type="search" placeholder="Search" autocomplete="off" spellcheck="false"><kbd aria-hidden="true">/</kbd><div class="nix-search-panel" hidden><p role="status" aria-live="polite"></p><ul></ul></div></div>`
      : '';

  const footer = [
    settings.footerText.length > 0 ? `<p>${escapeHtml(settings.footerText)}</p>` : '',
    `<ul>${model.nodes
      .filter((node) => node.collection !== null)
      .map(
        (node) =>
          `<li><a href="${escapeHtml(`${node.page.path}feed.xml`)}">${escapeHtml(node.page.title)} feed</a></li>`,
      )
      .join('')}${
      settings.builtWithNix
        ? `<li><a class="nix-built" href="${BUILT_WITH_NIX_URL}"><span class="nix-glyph" aria-hidden="true"></span>Built with Nix</a></li>`
        : ''
    }</ul>`,
  ].join('');

  return `<!doctype html>
<html lang="${escapeHtml(settings.language)}">
<head>
${meta}
</head>
<body class="nix-site nix-layout-${layout}">
<a class="nix-skip" href="#content">Skip to content</a>
<header class="nix-top"><div class="nix-top-inner"><a class="nix-brand" href="/"><span class="nix-mark" aria-hidden="true"><i></i></span>${escapeHtml(name)}</a>${navigation(model, page.current)}<div class="nix-tools">${search}<button class="nix-theme" type="button" data-nix-theme hidden aria-label="Switch theme"><span aria-hidden="true"></span></button></div></div></header>
<main id="content" class="nix-main" tabindex="-1">
${page.body}
</main>
<footer class="nix-foot"><div class="nix-foot-inner">${footer}</div></footer>
</body>
</html>
`;
}

/** Ancestors as a breadcrumb, root first, ending at the page's parent. */
export function crumbs(node: SiteNode, siteName: string): string {
  const chain: SiteNode[] = [];
  for (let parent = node.parent; parent !== null; parent = parent.parent) {
    chain.unshift(parent);
  }
  if (chain.length === 0) {
    return '';
  }
  return `<nav class="nix-crumbs" aria-label="Breadcrumb"><ol>${chain
    // The root's title is the home page's headline; the site's name reads better as a crumb.
    .map(
      (entry) =>
        `<li><a href="${escapeHtml(entry.page.path)}">${escapeHtml(entry.parent === null ? siteName : entry.page.title)}</a></li>`,
    )
    .join('')}</ol></nav>`;
}
