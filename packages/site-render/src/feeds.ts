import { escapeHtml } from './html/escape.js';
import {
  entriesOf,
  latest,
  modifiedAt,
  rfc3339,
  type SiteModel,
  type SiteNode,
} from './site-model.js';
import { absolute } from './theme/shell.js';
import { entryTags, summaryOf } from './theme/parts.js';

/**
 * One Atom feed per dated collection, at `<collection path>feed.xml`, newest entry first.
 * Dates are the manifest's own; a bare day is read as midnight UTC. An entry's `<updated>` is its
 * last real change (the same instant the sitemap's `lastmod` uses), and the feed's is the latest
 * of those.
 */

export function renderFeed(model: SiteModel, collection: SiteNode): string {
  const { builtAt, settings } = model.manifest;
  const entries = entriesOf(collection);
  const url = absolute(model, collection.page.path);
  const updated = latest(entries.map(modifiedAt)) || builtAt;
  const items = entries
    .map((entry) => {
      const link = absolute(model, entry.page.path);
      const published = rfc3339(entry.page.publishedAt, builtAt);
      const summary = summaryOf(entry);
      return `<entry>
<title>${escapeHtml(entry.page.title)}</title>
<id>${escapeHtml(link)}</id>
<link rel="alternate" type="text/html" href="${escapeHtml(link)}"/>
<published>${escapeHtml(published)}</published>
<updated>${escapeHtml(modifiedAt(entry))}</updated>
${summary.length > 0 ? `<summary>${escapeHtml(summary)}</summary>\n` : ''}${entryTags(entry)
        .map((tag) => `<category term="${escapeHtml(tag)}"/>\n`)
        .join('')}<content type="html">${escapeHtml(entry.prose?.html ?? '')}</content>
</entry>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${escapeHtml(settings.language)}" xml:base="${escapeHtml(`${model.manifest.canonicalOrigin}/`)}">
<title>${escapeHtml(`${settings.name}: ${collection.page.title}`)}</title>
<id>${escapeHtml(url)}</id>
<link rel="self" type="application/atom+xml" href="${escapeHtml(`${url}feed.xml`)}"/>
<link rel="alternate" type="text/html" href="${escapeHtml(url)}"/>
<updated>${escapeHtml(updated)}</updated>
<generator uri="https://github.com/sianachi/nix">Nix</generator>
${items}
</feed>
`;
}
