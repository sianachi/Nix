import { describe, expect, it } from 'vitest';

import { renderSite } from './render.js';
import { aSite, fileText } from './site.test-helper.js';

describe('feeds and the sitemap', () => {
  const rendered = renderSite(aSite());

  it('writes one Atom feed per dated collection, newest first', () => {
    const feed = fileText(rendered.files, 'posts/feed.xml');
    expect(feed).toContain('<feed xmlns="http://www.w3.org/2005/Atom"');
    expect(feed.indexOf('Second post')).toBeLessThan(feed.indexOf('First post'));
    expect(feed).toContain('<published>2026-05-01T00:00:00Z</published>');
    expect(feed).toContain('<updated>2026-05-01T00:00:00Z</updated>');
    expect(feed).toContain('<category term="Beta Tag"/>');
  });

  it('lists every published page and tag page in the sitemap, and nothing else', () => {
    const sitemap = fileText(rendered.files, 'sitemap.xml');
    const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
    expect(locs).toEqual(
      [
        '/',
        '/lists/',
        '/lists/one/',
        '/posts/',
        '/posts/first/',
        '/posts/second/',
        '/posts/tag/alpha/',
        '/posts/tag/beta-tag/',
      ].map((path) => `https://example.test${path}`),
    );
    expect(fileText(rendered.files, 'robots.txt')).toContain(
      'Sitemap: https://example.test/sitemap.xml',
    );
  });
});
