import type { PropertyDefinition, SchemaSnapshot } from '@nix/export';

import { escapeHtml, safeHref } from '../html/escape.js';
import { formatDate, type SiteModel, type SiteNode } from '../site-model.js';

/**
 * A page's properties, shown as facts: a compact definition list under the title, and a shorter
 * one on its card. Labels and types come from the schema in force at the page (its own, or the
 * nearest ancestor's), and a page with no schema still shows plain text, lists and links.
 *
 * Hidden: the title, system keys (`$...`), types that name people or are computed or are pictures
 * (assignee, reminder, formula, rollup, image), on an entry the properties its dated collection
 * reads (date, tags, cover, summary), a file that is a picture rather than a download (a card's cover), the
 * subtitle (shown as the lead instead), and every empty value.
 */

const HIDDEN_TYPES = new Set(['assignee', 'reminder', 'formula', 'rollup', 'image']);
const DATE_TYPES = new Set(['date', 'due_date', 'start_date', 'timestamp', 'datetime']);
const SUBTITLE = /^(subtitle|summary|description|tagline)$/i;
const NIX_FILE = /^nix-file:([0-9a-zA-Z-]{1,64})$/;
/** The reserved property that keeps one page out of search engines: a checkbox named so. */
const NOINDEX = /^(no-?index|hide from search engines)$/i;

interface Fact {
  readonly label: string;
  /** For a page, where links may be links. */
  readonly html: string;
  /** For a card, which is itself a link, so it holds no other. */
  readonly cardHtml: string;
}

function schemaOf(node: SiteNode): SchemaSnapshot | null {
  for (let at: SiteNode | null = node; at !== null; at = at.parent) {
    if (at.page.schema !== null) {
      return at.page.schema;
    }
  }
  return null;
}

function humanize(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').trim();
  return words.length === 0 ? key : `${words[0]?.toUpperCase() ?? ''}${words.slice(1)}`;
}

const chips = (values: readonly string[]): string =>
  `<ul class="nix-tags">${values.map((value) => `<li><span class="nix-tag">${escapeHtml(value)}</span></li>`).join('')}</ul>`;

function strings(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** The subtitle property's key: one named or labelled subtitle, summary, description or tagline. */
function subtitleKey(node: SiteNode, schema: SchemaSnapshot | null): string | null {
  for (const key of Object.keys(node.page.properties)) {
    const label = schema?.properties.find((property) => property.key === key)?.label ?? '';
    if (SUBTITLE.test(key) || SUBTITLE.test(label)) {
      const value = node.page.properties[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return key;
      }
    }
  }
  return null;
}

/** The page's own "noindex" property key, named or labelled so, or null. */
function noindexKey(node: SiteNode, schema: SchemaSnapshot | null): string | null {
  return (
    Object.keys(node.page.properties).find(
      (key) =>
        NOINDEX.test(key) ||
        NOINDEX.test(schema?.properties.find((property) => property.key === key)?.label ?? ''),
    ) ?? null
  );
}

/**
 * Whether a page asks search engines to leave it out: a `noindex` (or "Hide from search engines")
 * checkbox that is ticked. The page is still published and linked; it only gains
 * `<meta name="robots" content="noindex">` and leaves the sitemap.
 */
export function isNoindex(node: SiteNode): boolean {
  const key = noindexKey(node, schemaOf(node));
  const value = key === null ? null : node.page.properties[key];
  return value === true || value === 'true';
}

/** A one-line subtitle for a page, from a text property such as `subtitle`, or null. */
export function subtitleOf(node: SiteNode): string | null {
  const key = subtitleKey(node, schemaOf(node));
  const value = key === null ? null : node.page.properties[key];
  return typeof value === 'string' ? value.trim() : null;
}

function fact(model: SiteModel, value: unknown, type: string | null, label: string): Fact | null {
  const one = (html: string, cardHtml = html): Fact => ({ label, html, cardHtml });
  if (value === null || value === undefined) {
    return null;
  }
  if (type === 'checkbox' || type === 'completion' || typeof value === 'boolean') {
    return typeof value === 'boolean' ? one(value ? 'Yes' : 'No') : null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? one(escapeHtml(String(value))) : null;
  }
  const texts = strings(value);
  if (texts.length === 0) {
    return null;
  }
  const first = texts[0] ?? '';
  if (type === 'multi_select' || (type !== 'select' && Array.isArray(value))) {
    return one(chips(texts));
  }
  if (type === 'select') {
    return one(chips([first]));
  }
  if (type !== null && DATE_TYPES.has(type)) {
    const date = formatDate(first);
    return date.length === 0
      ? null
      : one(`<time datetime="${escapeHtml(first.slice(0, 10))}">${date}</time>`);
  }
  const file = NIX_FILE.exec(first);
  if (file?.[1] !== undefined) {
    // A picture property is shown as a cover, not as a fact; only a download is a fact.
    const download = model.download(file[1]);
    return download === null
      ? null
      : one(
          `<a class="nix-file-link" href="${escapeHtml(download.url)}">${escapeHtml(download.name)}</a> <span class="nix-file-meta">${escapeHtml(download.label)}</span>`,
          escapeHtml(download.name),
        );
  }
  const href = /^https?:\/\//i.test(first) ? safeHref(first) : null;
  if (href !== null && (type === 'url' || type === null || type === 'text')) {
    const shown = first.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
    return one(
      `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${escapeHtml(shown)}</a>`,
      escapeHtml(shown),
    );
  }
  return one(escapeHtml(first));
}

function factsOf(model: SiteModel, node: SiteNode): Fact[] {
  const schema = schemaOf(node);
  const hidden = new Set<string>(['title']);
  // An entry shows its collection's date, tags, cover and summary in its own way.
  const collection = node.parent?.collection ?? null;
  if (collection !== null) {
    for (const key of [
      collection.dateProperty,
      collection.tagsProperty,
      collection.coverProperty,
      collection.summaryProperty,
    ]) {
      if (key !== null) hidden.add(key);
    }
  }
  const subtitle = subtitleKey(node, schema);
  if (subtitle !== null) hidden.add(subtitle);
  const noindex = noindexKey(node, schema);
  if (noindex !== null) hidden.add(noindex);

  const definitions = new Map<string, PropertyDefinition>(
    (schema?.properties ?? []).map((property) => [property.key, property]),
  );
  // Schema order first, then any other keys in the order they are stored.
  const keys = [...new Set([...definitions.keys(), ...Object.keys(node.page.properties)])].filter(
    (key) => key in node.page.properties,
  );

  const facts: Fact[] = [];
  for (const key of keys) {
    const definition = definitions.get(key) ?? null;
    if (hidden.has(key) || key.startsWith('$') || HIDDEN_TYPES.has(definition?.type ?? '')) {
      continue;
    }
    const shown = fact(
      model,
      node.page.properties[key],
      definition?.type ?? null,
      definition?.label ?? humanize(key),
    );
    if (shown !== null) facts.push(shown);
  }
  return facts;
}

/** The facts block under a page's title, or empty when the page has none. */
export function factsBlock(model: SiteModel, node: SiteNode): string {
  const facts = factsOf(model, node);
  return facts.length === 0
    ? ''
    : `<dl class="nix-facts">${facts.map((entry) => `<div><dt>${escapeHtml(entry.label)}</dt><dd>${entry.html}</dd></div>`).join('')}</dl>`;
}

/** At most `limit` fact values for a list row, each named for screen readers. */
export function rowFacts(model: SiteModel, node: SiteNode, limit = 2): string {
  const facts = factsOf(model, node).slice(0, limit);
  return facts.length === 0
    ? ''
    : `<span class="nix-index-facts">${facts.map((entry) => `<span><span class="sr-only">${escapeHtml(entry.label)}: </span>${entry.cardHtml}</span>`).join('')}</span>`;
}

/** At most `limit` facts for a card, without links, since the card is one. */
export function cardFacts(model: SiteModel, node: SiteNode, limit = 3): string {
  const facts = factsOf(model, node).slice(0, limit);
  return facts.length === 0
    ? ''
    : `<dl class="nix-facts nix-facts-compact">${facts.map((entry) => `<div><dt>${escapeHtml(entry.label)}</dt><dd>${entry.cardHtml}</dd></div>`).join('')}</dl>`;
}
