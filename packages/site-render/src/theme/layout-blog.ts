import { escapeHtml } from '../html/escape.js';
import { coverOf, entriesOf, isEntry, type SiteModel, type SiteNode } from '../site-model.js';
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
  postList,
  postsByYear,
  summaryOf,
  tagList,
} from './parts.js';
import { factsBlock, subtitleOf } from './facts.js';

/**
 * The blog and portfolio layout: a home page that introduces the author and features each
 * collection, collection indexes grouped by year, posts with date, reading time, tags and cover,
 * one page per tag, and plain pages for everything else.
 */

const FEATURED_ENTRIES = 5;

function sectionHead(node: SiteNode, caption: string, id: string): string {
  return `<div class="nix-section-head"><h2 id="${id}">${glyph()}<a href="${escapeHtml(node.page.path)}">${escapeHtml(node.page.title)}</a></h2><p>${escapeHtml(caption)}</p></div>`;
}

function home(model: SiteModel): string {
  const root = model.root;
  const sections = root.children
    .filter((child) => child.children.length > 0)
    .map((child, index) => {
      const id = `nix-section-${String(index + 1)}`;
      if (child.collection !== null) {
        const entries = entriesOf(child);
        return `<section class="nix-section" aria-labelledby="${id}">${sectionHead(child, plural(entries.length, 'post'), id)}${postList(entries.slice(0, FEATURED_ENTRIES))}</section>`;
      }
      return `<section class="nix-section" aria-labelledby="${id}">${sectionHead(child, plural(child.children.length, 'page'), id)}${cards(model, child, child.children)}</section>`;
    })
    .join('');
  const pages = root.children.filter((child) => child.children.length === 0);
  const more =
    pages.length === 0
      ? ''
      : `<section class="nix-section" aria-labelledby="nix-section-pages"><div class="nix-section-head"><h2 id="nix-section-pages">${glyph()}Pages</h2></div>${cards(model, root, pages)}</section>`;

  const body = `<section class="nix-hero"><h1 class="nix-hero-title">${escapeHtml(root.page.title)}</h1>${
    model.manifest.settings.description.length > 0
      ? `<p class="nix-hero-lead">${escapeHtml(model.manifest.settings.description)}</p>`
      : ''
  }</section>${
    root.prose === null || root.prose.html.length === 0
      ? ''
      : `<div class="nix-prose nix-section">${root.prose.html}</div>`
  }${sections}${more}`;

  return renderShell(model, {
    path: '/',
    title: root.page.title,
    description: model.manifest.settings.description,
    kind: 'website',
    image: null,
    current: root,
    body,
  });
}

function collectionPage(model: SiteModel, node: SiteNode): string {
  const entries = entriesOf(node);
  const tags = allTags(node);
  const body = `<article class="nix-article"><header class="nix-article-head">${crumbs(node, model.manifest.settings.name)}<h1 class="nix-title">${escapeHtml(node.page.title)}</h1><div class="nix-meta"><span>${plural(entries.length, 'post')}</span><a href="${escapeHtml(`${node.page.path}feed.xml`)}">Atom feed</a></div></header>${
    node.prose === null || node.prose.html.length === 0
      ? ''
      : `<div class="nix-prose">${node.prose.html}</div>`
  }${tags.length === 0 ? '' : `<nav aria-label="Tags">${tagList(node, tags)}</nav>`}${postsByYear(entries)}</article>`;
  return renderShell(model, {
    path: node.page.path,
    title: node.page.title,
    description: excerpt(node, 160),
    kind: 'website',
    image: null,
    current: node,
    body,
  });
}

function tagPage(
  model: SiteModel,
  collection: SiteNode,
  path: string,
  tag: string,
  entries: readonly SiteNode[],
): string {
  const body = `<article class="nix-article"><header class="nix-article-head"><nav class="nix-crumbs" aria-label="Breadcrumb"><ol><li><a href="/">${escapeHtml(model.manifest.settings.name)}</a></li><li><a href="${escapeHtml(collection.page.path)}">${escapeHtml(collection.page.title)}</a></li></ol></nav><h1 class="nix-title">Tagged ${escapeHtml(tag)}</h1><div class="nix-meta"><span>${plural(entries.length, 'post')}</span></div></header>${postsByYear(entries)}</article>`;
  return renderShell(model, {
    path,
    title: `Tagged ${tag}`,
    description: `${collection.page.title} posts tagged ${tag}.`,
    kind: 'website',
    image: null,
    current: collection,
    body,
  });
}

function post(model: SiteModel, node: SiteNode, collection: SiteNode): string {
  const entries = entriesOf(collection);
  const index = entries.indexOf(node);
  const cover = coverOf(model, node, collection.collection?.coverProperty ?? null);
  const coverHtml =
    cover === null
      ? ''
      : `<figure class="nix-cover"><img src="${escapeHtml(cover.url)}" alt=""${cover.width !== null && cover.height !== null ? ` width="${String(cover.width)}" height="${String(cover.height)}"` : ''} decoding="async"></figure>`;
  const body = `<article class="nix-article"><header class="nix-article-head">${crumbs(node, model.manifest.settings.name)}<h1 class="nix-title">${escapeHtml(node.page.title)}</h1>${entryMeta(node)}</header>${coverHtml}<div class="nix-prose">${node.prose?.html ?? ''}${node.viewHtml}</div>${pager(entries[index + 1] ?? null, entries[index - 1] ?? null, ['Older', 'Newer'])}</article>`;
  return renderShell(model, {
    path: node.page.path,
    title: node.page.title,
    description: summaryOf(node),
    kind: 'article',
    image: cover,
    publishedAt: node.page.publishedAt,
    current: node,
    body,
  });
}

function lead(node: SiteNode): string {
  const subtitle = subtitleOf(node);
  return subtitle === null ? '' : `<p class="nix-lead">${escapeHtml(subtitle)}</p>`;
}

function plainPage(model: SiteModel, node: SiteNode): string {
  const children =
    node.viewHtml.length === 0 && node.children.length > 0 ? cards(model, node, node.children) : '';
  const body = `<article class="nix-article"><header class="nix-article-head">${crumbs(node, model.manifest.settings.name)}<h1 class="nix-title">${escapeHtml(node.page.title)}</h1>${lead(node)}${factsBlock(model, node)}</header><div class="nix-prose">${node.prose?.html ?? ''}</div>${node.viewHtml}${children}</article>`;
  return renderShell(model, {
    path: node.page.path,
    title: node.page.title,
    description: excerpt(node, 160),
    kind: 'website',
    image: null,
    current: node,
    body,
  });
}

export function renderBlogPages(model: SiteModel): Map<string, string> {
  const pages = new Map<string, string>([['/', home(model)]]);
  const generated = new Map<string, string>();
  for (const node of model.nodes) {
    if (node === model.root) {
      continue;
    }
    if (node.collection !== null) {
      pages.set(node.page.path, collectionPage(model, node));
      for (const [path, { tag, entries }] of collectionTags(node)) {
        generated.set(path, tagPage(model, node, path, tag, entries));
      }
    } else if (isEntry(node) && node.parent !== null) {
      pages.set(node.page.path, post(model, node, node.parent));
    } else {
      pages.set(node.page.path, plainPage(model, node));
    }
  }
  addGeneratedPages(pages, generated);
  return pages;
}
