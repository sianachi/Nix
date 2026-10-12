import { escapeHtml } from './html/escape.js';
import type { SiteModel } from './site-model.js';

/** `sitemap.xml` over every published HTML page, and the `robots.txt` that points at it. */

export function renderSitemap(model: SiteModel, paths: readonly string[]): string {
  const lastmod = new Map(
    model.nodes.map((node) => [node.page.path, node.page.updatedAt.slice(0, 10)]),
  );
  const urls = [...paths]
    .sort()
    .map((path) => {
      const day = lastmod.get(path);
      return `<url><loc>${escapeHtml(`${model.manifest.canonicalOrigin}${path}`)}</loc>${
        day !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(day) ? `<lastmod>${day}</lastmod>` : ''
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
  return `User-agent: *\nAllow: /\nSitemap: ${model.manifest.canonicalOrigin}/sitemap.xml\n`;
}
