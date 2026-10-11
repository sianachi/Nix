import { escapeHtml } from '../html/escape.js';
import { SiteManifestError } from '../manifest.js';
import { defaultView } from '../html/views.js';
import {
  coverOf,
  entriesOf,
  formatDate,
  isoDay,
  readingMinutes,
  stringProperty,
  tagsOf,
  type SiteModel,
  type SiteNode,
} from '../site-model.js';
import { cardFacts, subtitleOf } from './facts.js';

/** Pieces both layouts draw: the home map, post rows, cards, tags and the pager. */

export const glyph = (hollow = false): string =>
  `<span class="nix-glyph${hollow ? ' nix-glyph-hollow' : ''}" aria-hidden="true"></span>`;

export function plural(count: number, noun: string, many = `${noun}s`): string {
  return `${String(count)} ${count === 1 ? noun : many}`;
}

/** The first sentence or so of a page's body text (never a heading), for cards and rows. */
export function excerpt(node: SiteNode, limit = 150): string {
  const text = node.prose?.summary ?? '';
  if (text.length <= limit) {
    return text;
  }
  const cut = text.slice(0, limit);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 40)).replace(/[\s,.;:]+$/, '')}...`;
}

export function summaryOf(node: SiteNode): string {
  const collection = node.parent?.collection ?? null;
  return stringProperty(node, collection?.summaryProperty ?? null) ?? excerpt(node);
}

/** A tag's page path under its collection. */
export function tagPath(collection: SiteNode, tag: string): string {
  const slug = tag
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${collection.page.path}tag/${slug.length === 0 ? 'tag' : slug}/`;
}

export function tagList(collection: SiteNode | null, tags: readonly string[]): string {
  if (tags.length === 0) {
    return '';
  }
  return `<ul class="nix-tags" aria-label="Tags">${tags
    .map((tag) =>
      collection === null
        ? `<li><span class="nix-tag">${escapeHtml(tag)}</span></li>`
        : `<li><a class="nix-tag" href="${escapeHtml(tagPath(collection, tag))}">${escapeHtml(tag)}</a></li>`,
    )
    .join('')}</ul>`;
}

export function entryTags(node: SiteNode): string[] {
  return tagsOf(node, node.parent?.collection?.tagsProperty ?? null);
}

/** A dated entry as a row: date, title, summary, tags. */
export function postRow(node: SiteNode, heading = 'h3'): string {
  const collection = node.parent;
  const summary = summaryOf(node);
  return `<li class="nix-post-row"><time datetime="${isoDay(node.page.publishedAt)}">${formatDate(node.page.publishedAt)}</time><div><${heading}><a href="${escapeHtml(node.page.path)}">${escapeHtml(node.page.title)}</a></${heading}>${
    summary.length > 0 ? `<p>${escapeHtml(summary)}</p>` : ''
  }${tagList(collection, entryTags(node))}</div></li>`;
}

export function postList(nodes: readonly SiteNode[], heading = 'h3'): string {
  return `<ul class="nix-posts">${nodes.map((node) => postRow(node, heading)).join('')}</ul>`;
}

/** Entries grouped under their year, newest first. */
export function postsByYear(nodes: readonly SiteNode[]): string {
  const years = new Map<string, SiteNode[]>();
  for (const node of nodes) {
    const year = (node.page.publishedAt ?? '').slice(0, 4) || 'Undated';
    years.set(year, [...(years.get(year) ?? []), node]);
  }
  return [...years]
    .map(([year, entries]) => `<h2 class="nix-year">${escapeHtml(year)}</h2>${postList(entries)}`)
    .join('');
}

/** Child pages as cards: cover (from the parent's gallery view), title, excerpt. */
export function cards(model: SiteModel, parent: SiteNode, children: readonly SiteNode[]): string {
  const coverProperty = defaultView(parent)?.coverProperty ?? null;
  return `<ul class="nix-cards">${children
    .map((child) => {
      const cover = coverOf(model, child, coverProperty);
      // A blank frame only where the view expects covers; otherwise the card is text.
      const image =
        cover === null
          ? coverProperty === null
            ? ''
            : '<span class="nix-card-blank" aria-hidden="true"></span>'
          : `<img src="${escapeHtml(cover.url)}" alt=""${cover.width !== null && cover.height !== null ? ` width="${String(cover.width)}" height="${String(cover.height)}"` : ''} loading="lazy" decoding="async">`;
      const summary = subtitleOf(child) ?? excerpt(child, 120);
      return `<li><a class="nix-card" href="${escapeHtml(child.page.path)}">${image}<span class="nix-card-body"><h3>${glyph()}${escapeHtml(child.page.title)}</h3>${summary.length > 0 ? `<p>${escapeHtml(summary)}</p>` : ''}${cardFacts(model, child)}</span></a></li>`;
    })
    .join('')}</ul>`;
}

/** What a branch of the map holds, said in the mono caption under its name. */
function branchCaption(node: SiteNode): string {
  if (node.collection !== null) {
    const entries = entriesOf(node);
    const latest = entries[0]?.page.publishedAt ?? null;
    return `${plural(entries.length, 'entry', 'entries')}${latest === null ? '' : ` / latest ${formatDate(latest)}`}`;
  }
  return node.children.length === 0 ? 'page' : plural(node.children.length, 'page');
}

function subtree(node: SiteNode, depth: number): string {
  const children = node.collection !== null ? entriesOf(node).slice(0, 3) : node.children;
  if (children.length === 0 || depth > 2) {
    return '';
  }
  return `<ul>${children
    .map(
      (child) =>
        `<li><a href="${escapeHtml(child.page.path)}">${escapeHtml(child.page.title)}</a>${subtree(child, depth + 1)}</li>`,
    )
    .join('')}</ul>`;
}

/**
 * The home page's map: the site's real tree, root to its branches and their pages, drawn with
 * the same hairlines as the docs sidebar. It is the theme's signature, and it is true: it shows
 * exactly what the site holds.
 */
export function siteMap(model: SiteModel): string {
  const branches = model.root.children;
  if (branches.length === 0) {
    return '';
  }
  return `<section class="nix-map" aria-labelledby="nix-map-title"><h2 id="nix-map-title" class="nix-map-root">${glyph()}<span>${escapeHtml(model.manifest.settings.name)} / ${plural(model.nodes.length, 'page')}</span></h2><ul class="nix-map-branches">${branches
    .map(
      (branch) =>
        `<li class="nix-map-branch"><a href="${escapeHtml(branch.page.path)}">${glyph()}${escapeHtml(branch.page.title)}</a><p>${escapeHtml(branchCaption(branch))}</p>${
          branch.children.length === 0
            ? ''
            : `<div class="nix-tree">${subtree(branch, 1).replace(/^<ul>/, '<ul class="nix-tree-root">')}</div>`
        }</li>`,
    )
    .join('')}</ul></section>`;
}

export function pager(
  previous: SiteNode | null,
  next: SiteNode | null,
  labels = ['Previous', 'Next'],
): string {
  if (previous === null && next === null) {
    return '';
  }
  const link = (node: SiteNode, label: string, className: string) =>
    `<a class="${className}" href="${escapeHtml(node.page.path)}" rel="${className === 'nix-pager-next' ? 'next' : 'prev'}"><small>${escapeHtml(label)}</small>${escapeHtml(node.page.title)}</a>`;
  return `<nav class="nix-pager" aria-label="More pages">${previous === null ? '' : link(previous, labels[0] ?? 'Previous', 'nix-pager-prev')}${next === null ? '' : link(next, labels[1] ?? 'Next', 'nix-pager-next')}</nav>`;
}

export function entryMeta(node: SiteNode): string {
  const published = node.page.publishedAt;
  return `<div class="nix-meta">${
    published === null
      ? ''
      : `<time datetime="${isoDay(published)}">${formatDate(published)}</time>`
  }<span>${String(readingMinutes(node))} min read</span>${tagList(node.parent, entryTags(node))}</div>`;
}

/** Tag pages by path; two tags that slug alike share a page named after the first seen. */
export function collectionTags(
  collection: SiteNode,
): Map<string, { readonly tag: string; readonly entries: SiteNode[] }> {
  const tags = new Map<string, { tag: string; entries: SiteNode[] }>();
  for (const entry of entriesOf(collection)) {
    for (const tag of entryTags(entry)) {
      const path = tagPath(collection, tag);
      const existing = tags.get(path);
      if (existing === undefined) {
        tags.set(path, { tag, entries: [entry] });
      } else {
        existing.entries.push(entry);
      }
    }
  }
  return tags;
}

/** Tags across a collection's entries, sorted, for its tag navigation. */
export function allTags(collection: SiteNode): string[] {
  return [...new Set(entriesOf(collection).flatMap(entryTags))].sort((a, b) => a.localeCompare(b));
}

/** Adds generated pages (tag pages), refusing any that would stand where a published page does. */
export function addGeneratedPages(
  pages: Map<string, string>,
  generated: ReadonlyMap<string, string>,
): void {
  for (const [path, html] of generated) {
    if (pages.has(path)) {
      throw new SiteManifestError(`The tag page ${path} would replace a published page.`);
    }
    pages.set(path, html);
  }
}
