import { escapeHtml } from './html/escape.js';
import { entriesOf, latest, modifiedAt, type SiteModel } from './site-model.js';
import { isNoindex } from './theme/facts.js';
import { collectionTags } from './theme/parts.js';

/**
 * `sitemap.xml` over every published HTML page a search engine may index, and the `robots.txt`
 * that points at it.
 *
 * `lastmod` is each page's last real change (`modifiedAt`: its own edit or its body's, never the
 * build date), and a tag page's is its newest entry's. A page marked noindex is left out; a site
 * hidden from search engines gets a robots.txt that disallows everything and names no sitemap.
 */

export function renderSitemap(model: SiteModel, paths: readonly string[]): string {
  const lastmod = new Map(model.nodes.map((node) => [node.page.path, modifiedAt(node)]));
  const hidden = new Set(model.nodes.filter(isNoindex).map((node) => node.page.path));
  for (const node of model.nodes) {
    if (node.collection !== null) {
      for (const [path, { entries }] of collectionTags(node)) {
        lastmod.set(path, latest(entries.map(modifiedAt)));
      }
      // Keep the collection itself as fresh as its newest entry.
      lastmod.set(node.page.path, latest([modifiedAt(node), ...entriesOf(node).map(modifiedAt)]));
    }
  }
  const urls = [...paths]
    .filter((path) => !hidden.has(path))
    .sort()
    .map((path) => {
      const day = (lastmod.get(path) ?? '').slice(0, 10);
      return `<url><loc>${escapeHtml(`${model.manifest.canonicalOrigin}${path}`)}</loc>${
        /^\d{4}-\d{2}-\d{2}$/.test(day) ? `<lastmod>${day}</lastmod>` : ''
      }</url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

export function renderRobots(model: SiteModel): string {
  return model.manifest.settings.noindex
    ? 'User-agent: *\nDisallow: /\n'
    : `User-agent: *\nAllow: /\nSitemap: ${model.manifest.canonicalOrigin}/sitemap.xml\n`;
}
