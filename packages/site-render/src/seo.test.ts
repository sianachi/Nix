import { describe, expect, it } from 'vitest';

import type { SitePage } from './manifest.js';
import { MAX_PREVIEW_IMAGES, renderSite, type RenderSiteInput } from './render.js';
import { aManifest, aPage, aSite, fileText } from './site.test-helper.js';
import { loadPreviewRasterizer, previewSvg, woffToSfnt, wrapTitle } from './theme/preview-image.js';

/** Search and link-preview output: JSON-LD, Open Graph, preview cards, lastmod and noindex. */

const encoder = new TextEncoder();
/** A stand-in rasteriser: distinct bytes per card, no WASM. */
const fakePreviews = (svg: string): Uint8Array => encoder.encode(svg);

function withPreviews(input: RenderSiteInput): RenderSiteInput {
  return { ...input, previews: fakePreviews };
}

type Node = Record<string, unknown>;

function jsonLd(html: string): Node[] {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)];
  expect(blocks).toHaveLength(1);
  const data = JSON.parse(blocks[0]?.[1] ?? '') as { '@context': string; '@graph': Node[] };
  expect(data['@context']).toBe('https://schema.org');
  return data['@graph'];
}

function ofType(graph: Node[], type: string): Node {
  const node = graph.find((entry) => entry['@type'] === type);
  if (node === undefined) throw new Error(`no ${type}`);
  return node;
}

function meta(html: string, property: string): string[] {
  return [
    ...html.matchAll(new RegExp(`<meta (?:property|name)="${property}" content="([^"]*)">`, 'g')),
  ].map((match) => match[1] ?? '');
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/;

/** Google's breadcrumb rules: positions from 1, a name each, and an absolute item URL. */
function expectBreadcrumb(graph: Node[], paths: string[]): void {
  const list = ofType(graph, 'BreadcrumbList');
  const items = list.itemListElement as Node[];
  expect(items.map((item) => item.position)).toEqual(paths.map((_, index) => index + 1));
  expect(items.map((item) => item.item)).toEqual(
    paths.map((path) => `https://example.test${path}`),
  );
  for (const item of items) {
    expect(item['@type']).toBe('ListItem');
    expect(typeof item.name).toBe('string');
    expect((item.name as string).length).toBeGreaterThan(0);
  }
}

describe('structured data', () => {
  it('marks a dated post as a BlogPosting with the properties Google reads', () => {
    const site = aSite();
    const input = withPreviews({
      ...site,
      manifest: { ...site.manifest, settings: { ...site.manifest.settings, author: 'Ada Writer' } },
    });
    const html = fileText(renderSite(input).files, 'posts/first/index.html');
    const graph = jsonLd(html);
    const post = ofType(graph, 'BlogPosting');
    expect(post.headline).toBe('First post');
    expect(post.datePublished).toBe('2026-03-01T00:00:00Z');
    expect(post.dateModified).toMatch(ISO);
    expect(post.author).toEqual({
      '@type': 'Person',
      name: 'Ada Writer',
      url: 'https://example.test/',
    });
    expect(post.keywords).toBe('alpha, Beta Tag');
    expect(post.mainEntityOfPage).toEqual({
      '@type': 'WebPage',
      '@id': 'https://example.test/posts/first/',
    });
    expect((post.image as string[])[0]).toMatch(
      /^https:\/\/example\.test\/_nix\/assets\/[0-9a-f]{64}\.png$/,
    );
    expectBreadcrumb(graph, ['/', '/posts/', '/posts/first/']);
  });

  it('describes the home page as a WebSite, with the author as a Person on a blog', () => {
    const site = aSite();
    const settings = { ...site.manifest.settings, author: 'Ada Writer' };
    const graph = jsonLd(
      fileText(
        renderSite({ ...site, manifest: { ...site.manifest, settings } }).files,
        'index.html',
      ),
    );
    expect(ofType(graph, 'WebSite')).toMatchObject({
      name: 'Test site',
      url: 'https://example.test/',
      author: { '@id': 'https://example.test/#person' },
    });
    expect(ofType(graph, 'Person')).toMatchObject({ name: 'Ada Writer' });
    expect(graph.some((node) => node['@type'] === 'BreadcrumbList')).toBe(false);

    const plain = jsonLd(fileText(renderSite(aSite()).files, 'index.html'));
    expect(plain.map((node) => node['@type'])).toEqual(['WebSite']);
  });

  it('marks docs pages as TechArticle and tag pages as CollectionPage', () => {
    const files = renderSite(aSite('docs')).files;
    const docs = jsonLd(fileText(files, 'lists/one/index.html'));
    expect(ofType(docs, 'TechArticle')).toMatchObject({ headline: 'List one' });
    expect(ofType(docs, 'TechArticle').datePublished).toMatch(ISO);
    expectBreadcrumb(docs, ['/', '/lists/', '/lists/one/']);

    const tag = jsonLd(fileText(files, 'posts/tag/alpha/index.html'));
    expect(ofType(tag, 'CollectionPage').name).toBe('Tagged alpha');
    expectBreadcrumb(tag, ['/', '/posts/', '/posts/tag/alpha/']);
  });

  it('escapes everything that could end the block or break a parser', () => {
    const hostile = 'Bye </script><script>alert(1)</script> & <!-- \u2028\u2029';
    const site = aSite();
    const pages = site.pages.map((page) =>
      page.itemId === 'l1' ? { ...page, title: hostile } : page,
    );
    const html = fileText(renderSite({ ...site, pages }).files, 'lists/one/index.html');
    const block = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(html)?.[1] ?? '';
    expect(block).not.toMatch(/[<>&\u2028\u2029]/);
    expect(block).toContain('\\u003c/script\\u003e');
    expect(ofType(jsonLd(html), 'WebPage').name).toBe(hostile);
  });
});

describe('Open Graph and article metadata', () => {
  it('carries locale, preview image size and alt, and article times and tags', () => {
    const site = aSite();
    const settings = { ...site.manifest.settings, language: 'en-gb' };
    const html = fileText(
      renderSite(withPreviews({ ...site, manifest: { ...site.manifest, settings } })).files,
      'posts/first/index.html',
    );
    expect(meta(html, 'og:locale')).toEqual(['en_GB']);
    expect(meta(html, 'og:site_name')).toEqual(['Test site']);
    expect(meta(html, 'og:image')[0]).toMatch(
      /^https:\/\/example\.test\/_nix\/assets\/[0-9a-f]{64}\.png$/,
    );
    expect(meta(html, 'og:image:width')).toEqual(['1200']);
    expect(meta(html, 'og:image:height')).toEqual(['630']);
    expect(meta(html, 'og:image:alt')).toEqual(['First post']);
    expect(meta(html, 'article:published_time')).toEqual(['2026-03-01']);
    expect(meta(html, 'article:modified_time')).toEqual(['2026-03-01T00:00:00Z']);
    expect(meta(html, 'article:tag')).toEqual(['alpha', 'Beta Tag']);
    expect(meta(html, 'twitter:card')).toEqual(['summary_large_image']);
    expect(meta(html, 'generator')).toEqual(['Nix']);
    expect(html).toContain('Built with Nix');
  });

  it('falls back to a summary card without a preview image', () => {
    const html = fileText(renderSite(aSite()).files, 'lists/index.html');
    expect(meta(html, 'og:image')).toEqual([]);
    expect(meta(html, 'twitter:card')).toEqual(['summary']);
  });

  it('gives every page a content-addressed preview asset, and none to the 404', () => {
    const { files } = renderSite(withPreviews(aSite()));
    const pngs = files.filter((file) => file.path.endsWith('.png'));
    for (const file of files.filter((entry) => entry.path.endsWith('.html'))) {
      const images = meta(new TextDecoder().decode(file.bytes), 'og:image');
      expect(images, file.path).toHaveLength(file.path === '404.html' ? 0 : 1);
    }
    expect(pngs.length).toBeGreaterThan(0);
    for (const png of pngs) {
      expect(png.kind).toBe('asset');
      expect(png.mediaType).toBe('image/png');
    }
  });

  it('caps the cards a build draws and shares the home card past the cap', () => {
    const many: SitePage[] = [aPage({ itemId: 'root', path: '/', title: 'Home' })];
    for (let index = 0; index < MAX_PREVIEW_IMAGES + 5; index += 1) {
      many.push(
        aPage({
          itemId: `p${String(index)}`,
          path: `/p${String(index)}/`,
          title: `Page ${String(index)}`,
          parentItemId: 'root',
          ordinal: index + 1,
        }),
      );
    }
    const rendered = renderSite(
      withPreviews({
        manifest: aManifest({ pageCount: many.length }),
        pages: many,
        bodies: new Map(),
        assets: new Map(),
      }),
    );
    expect(rendered.files.filter((file) => file.path.endsWith('.png'))).toHaveLength(
      MAX_PREVIEW_IMAGES,
    );
    const home = meta(fileText(rendered.files, 'index.html'), 'og:image');
    const last = meta(
      fileText(rendered.files, `p${String(MAX_PREVIEW_IMAGES + 4)}/index.html`),
      'og:image',
    );
    expect(last).toEqual(home);
    expect(rendered.loss.some((entry) => entry.detail.includes('link-preview'))).toBe(true);
  });
});

describe('the preview card', () => {
  it('is a valid 1200 by 630 PNG, the same bytes every time', async () => {
    const rasterize = await loadPreviewRasterizer();
    const svg = previewSvg({
      siteName: 'Test site',
      title: 'A title long enough to need wrapping onto a second line of the card',
      caption: '1 March 2026',
      accent: '#336699', // design-token-exempt: a site setting as Core stores it.
    });
    const first = rasterize(svg);
    const second = rasterize(svg);
    expect(Buffer.from(first).subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const header = new DataView(first.buffer, first.byteOffset);
    expect(header.getUint32(16)).toBe(1200);
    expect(header.getUint32(20)).toBe(630);
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
  });

  it('wraps a title to at most three lines and escapes it', () => {
    const lines = wrapTitle('word '.repeat(80));
    expect(lines).toHaveLength(3);
    expect(lines[2]?.endsWith('\u2026')).toBe(true);
    expect(previewSvg({ siteName: '<s>', title: 'a & b', caption: '', accent: 'red' })).not.toMatch(
      /<s>|a & b/,
    );
  });

  it('turns WOFF into an SFNT a rasteriser can read', () => {
    expect(() => woffToSfnt(new Uint8Array(64))).toThrow(/WOFF/);
  });
});

describe('lastmod', () => {
  it('comes from each page and its newest entries, never the build date', () => {
    const site = aSite();
    const pages = site.pages.map((page) =>
      page.itemId === 'p2'
        ? { ...page, updatedAt: '2026-07-09T08:00:00Z' }
        : page.itemId === 'l1'
          ? { ...page, updatedAt: '2026-04-04T10:00:00+00:00' }
          : page,
    );
    const files = renderSite({ ...site, pages }).files;
    const sitemap = fileText(files, 'sitemap.xml');
    const lastmod = (path: string) =>
      new RegExp(`<loc>https://example\\.test${path}</loc><lastmod>([^<]+)</lastmod>`).exec(
        sitemap,
      )?.[1];
    expect(lastmod('/lists/one/')).toBe('2026-04-04');
    expect(lastmod('/posts/second/')).toBe('2026-07-09');
    expect(lastmod('/posts/')).toBe('2026-07-09');
    expect(lastmod('/posts/tag/alpha/')).toBe('2026-07-09');
    expect(sitemap).not.toContain('2026-10-11');

    const feed = fileText(files, 'posts/feed.xml');
    expect(feed).toContain('<updated>2026-07-09T08:00:00Z</updated>');
  });
});

describe('noindex', () => {
  it('hides a whole site from search engines when the setting is on', () => {
    const site = aSite();
    const settings = { ...site.manifest.settings, noindex: true };
    const files = renderSite({ ...site, manifest: { ...site.manifest, settings } }).files;
    expect(fileText(files, 'robots.txt')).toBe('User-agent: *\nDisallow: /\n');
    for (const file of files.filter((entry) => entry.path.endsWith('.html'))) {
      expect(meta(new TextDecoder().decode(file.bytes), 'robots'), file.path).toEqual(['noindex']);
    }
  });

  it('keeps one page out of the index and the sitemap with a noindex checkbox', () => {
    const site = aSite();
    const pages = site.pages.map((page) =>
      page.itemId === 'l1'
        ? {
            ...page,
            properties: { hidden_flag: true },
            schema: {
              properties: [
                {
                  key: 'hidden_flag',
                  label: 'Hide from search engines',
                  type: 'checkbox',
                  options: [],
                  required: false,
                },
              ],
              declared: [],
              inherit: true,
            },
          }
        : page,
    );
    const files = renderSite({ ...site, pages }).files;
    const html = fileText(files, 'lists/one/index.html');
    expect(meta(html, 'robots')).toEqual(['noindex']);
    expect(html).not.toContain('Hide from search engines');
    expect(meta(fileText(files, 'lists/index.html'), 'robots')).toEqual([]);
    expect(fileText(files, 'sitemap.xml')).not.toContain('/lists/one/');
    expect(fileText(files, 'robots.txt')).toContain('Allow: /');
  });
});
