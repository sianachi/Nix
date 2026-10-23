import { escapeHtml } from '../html/escape.js';
import {
  entriesOf,
  formatDate,
  isEntry,
  isoDay,
  type SiteModel,
  type SiteNode,
} from '../site-model.js';
import { crumbs, renderShell } from './shell.js';
import {
  addGeneratedPages,
  allTags,
  cards,
  collectionTags,
  entryMeta,
  excerpt,
  glyph,
  pager,
  plural,
  postsByYear,
  siteMap,
  tagList,
} from './parts.js';
import { factsBlock, subtitleOf } from './facts.js';

/**
 * The docs layout: a home page with the site's map, then every page with the tree in a sidebar,
 * an on-page table of contents, heading anchors, previous and next links, and search.
 */

function sideTree(model: SiteModel, current: SiteNode): string {
  const branch = (node: SiteNode): string => {
    const here = node === current;
    const inside = !here && current.page.path.startsWith(node.page.path);
    // A dated collection lists its entries on its own page, not in the sidebar.
    const children = node.collection === null ? node.children : [];
    return `<li><a href="${escapeHtml(node.page.path)}"${here ? ' aria-current="page"' : ''}>${glyph(!(here || inside))}<span>${escapeHtml(node.page.title)}</span></a>${
      children.length === 0 ? '' : `<ul>${children.map(branch).join('')}</ul>`
    }</li>`;
  };
  return `<ul class="nix-tree nix-side-tree">${model.root.children.map(branch).join('')}</ul>`;
}

function tocLinks(node: SiteNode): string {
  const headings = (node.prose?.headings ?? []).filter((heading) => heading.level <= 3);
  if (headings.length < 2) {
    return '';
  }
  return `<ul>${headings
    .map(
      (heading) =>
        `<li class="nix-toc-${String(heading.level)}"><a href="#${heading.id}">${escapeHtml(heading.text)}</a></li>`,
    )
    .join('')}</ul>`;
}

function toc(node: SiteNode): string {
  const links = tocLinks(node);
  return links === ''
    ? ''
    : `<nav class="nix-toc" aria-labelledby="nix-toc-title"><h2 id="nix-toc-title">On this page</h2>${links}</nav>`;
}

/** The contents list folded above the text, for screens too narrow for the side column. */
function tocFolded(node: SiteNode): string {
  const links = tocLinks(node);
  return links === ''
    ? ''
    : `<details class="nix-toc-folded"><summary>On this page</summary><nav aria-label="On this page">${links}</nav></details>`;
}

/** Reading order: the tree in manifest order, root excluded, entries newest first under their collection. */
function readingOrder(model: SiteModel): SiteNode[] {
  const order: SiteNode[] = [];
  const walk = (node: SiteNode) => {
    order.push(node);
    const children = node.collection === null ? node.children : entriesOf(node);
    children.forEach(walk);
  };
  model.root.children.forEach(walk);
  return order;
}

function home(model: SiteModel): string {
  const root = model.root;
  const body = `<section class="nix-hero"><p class="nix-eyebrow">${glyph()}<span>${escapeHtml(model.manifest.settings.name)}</span></p><h1 class="nix-hero-title">${escapeHtml(root.page.title)}</h1>${
    model.manifest.settings.description.length > 0
      ? `<p class="nix-hero-lead">${escapeHtml(model.manifest.settings.description)}</p>`
      : ''
  }</section>${siteMap(model)}<div class="nix-home-body"><div class="nix-prose">${root.prose?.html ?? ''}${root.viewHtml}</div></div>`;
  return renderShell(model, {
    path: '/',
    title: root.page.title,
    description: model.manifest.settings.description,
    kind: 'website',
    image: null,
    current: root,
    body,
    search: true,
  });
}

/** The docs chrome around an article: the tree in a sidebar (and a compact one), then the TOC. */
function frame(model: SiteModel, current: SiteNode, article: string, aside: string): string {
  const tree = sideTree(model, current);
  return `<div class="nix-docs"><nav class="nix-sidebar" aria-label="Docs">${tree}</nav><div class="nix-docs-column"><details class="nix-sidebar-mobile"><summary>Browse ${escapeHtml(model.manifest.settings.name)}</summary><nav aria-label="Docs (compact)">${tree}</nav></details>${article}</div>${aside}</div>`;
}

/** One tag of a dated collection: its entries by year, in the docs chrome. */
function tagPage(
  model: SiteModel,
  collection: SiteNode,
  path: string,
  tag: string,
  entries: readonly SiteNode[],
): string {
  const article = `<article class="nix-docs-article"><nav class="nix-crumbs" aria-label="Breadcrumb"><ol><li><a href="/">${escapeHtml(model.manifest.settings.name)}</a></li><li><a href="${escapeHtml(collection.page.path)}">${escapeHtml(collection.page.title)}</a></li></ol></nav><h1 class="nix-title">Tagged ${escapeHtml(tag)}</h1><div class="nix-meta"><span>${plural(entries.length, 'entry', 'entries')}</span></div>${postsByYear(entries)}</article>`;
  return renderShell(model, {
    path,
    title: `Tagged ${tag}`,
    description: `${collection.page.title} entries tagged ${tag}.`,
    kind: 'website',
    image: null,
    current: collection,
    body: frame(model, collection, article, ''),
    search: true,
  });
}

function page(model: SiteModel, node: SiteNode, order: readonly SiteNode[]): string {
  const index = order.indexOf(node);
  const entry = isEntry(node);
  const meta = entry
    ? entryMeta(node)
    : `<div class="nix-meta"><span>Updated <time datetime="${isoDay(node.page.updatedAt)}">${formatDate(node.page.updatedAt)}</time></span></div>`;

  let below = node.viewHtml;
  if (node.collection !== null) {
    const tags = allTags(node);
    below = `${tags.length === 0 ? '' : `<nav aria-label="Tags">${tagList(node, tags)}</nav>`}${postsByYear(entriesOf(node))}`;
  } else if (below.length === 0 && node.children.length > 0) {
    below = `<section class="nix-section-index" aria-labelledby="nix-in-section"><h2 id="nix-in-section">In this section</h2>${cards(model, node, node.children)}</section>`;
  }

  const subtitle = entry ? null : subtitleOf(node);
  const facts = entry ? '' : factsBlock(model, node);
  const article = `<article class="nix-docs-article">${crumbs(node, model.manifest.settings.name)}<h1 class="nix-title">${escapeHtml(node.page.title)}</h1>${subtitle === null ? '' : `<p class="nix-lead">${escapeHtml(subtitle)}</p>`}${meta}${facts}${tocFolded(node)}<div class="nix-prose">${node.prose?.html ?? ''}</div>${below}${pager(order[index - 1] ?? null, order[index + 1] ?? null)}</article>`;
  const body = frame(model, node, article, toc(node));

  return renderShell(model, {
    path: node.page.path,
    title: node.page.title,
    description: excerpt(node, 160),
    kind: entry ? 'article' : 'website',
    image: null,
    publishedAt: entry ? node.page.publishedAt : null,
    current: node,
    body,
    search: true,
  });
}

export function renderDocsPages(model: SiteModel): Map<string, string> {
  const pages = new Map<string, string>([['/', home(model)]]);
  const order = readingOrder(model);
  const generated = new Map<string, string>();
  for (const node of order) {
    pages.set(node.page.path, page(model, node, order));
    if (node.collection !== null) {
      for (const [path, { tag, entries }] of collectionTags(node)) {
        generated.set(path, tagPage(model, node, path, tag, entries));
      }
    }
  }
  addGeneratedPages(pages, generated);
  return pages;
}
