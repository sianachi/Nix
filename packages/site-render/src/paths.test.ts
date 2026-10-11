import { describe, expect, it } from 'vitest';

import { SiteManifestError, parseSiteManifest, parseSitePages } from './manifest.js';
import { renderSite } from './render.js';
import { aManifest, aPage, aSite, fileText } from './site.test-helper.js';

describe('site paths', () => {
  const manifest = aManifest({ pageCount: 2 });
  const root = aPage({ itemId: 'root', path: '/' });

  it.each(['/Upper/', '/no-slash', '/a//b/', '/../', '/-lead/', '/_nix/', `/${'a'.repeat(81)}/`])(
    'refuses the path %s',
    (path) => {
      expect(() =>
        parseSitePages(
          [root, aPage({ itemId: 'b', path, parentItemId: 'root', ordinal: 1 })],
          manifest,
        ),
      ).toThrow(SiteManifestError);
    },
  );

  it('refuses duplicate paths, a missing root and orphans', () => {
    const child = aPage({ itemId: 'b', path: '/b/', parentItemId: 'root', ordinal: 1 });
    expect(() => parseSitePages([root, { ...child, path: '/' }], manifest)).toThrow(
      /share the path/,
    );
    expect(() => parseSitePages([child, { ...child, itemId: 'c', path: '/c/' }], manifest)).toThrow(
      /root/,
    );
    expect(() => parseSitePages([root, { ...child, parentItemId: 'gone' }], manifest)).toThrow(
      /not in the manifest/,
    );
    expect(() => parseSitePages([root], manifest)).toThrow(/lists 2 pages/);
  });

  it('refuses a manifest over the page cap or with a bad accent', () => {
    expect(() => parseSiteManifest({ ...aManifest(), pageCount: 5_001 })).toThrow(
      SiteManifestError,
    );
    expect(() =>
      parseSiteManifest({ ...aManifest(), settings: { ...aManifest().settings, accent: 'red;}' } }),
    ).toThrow(SiteManifestError);
  });

  it('writes each page at <path>index.html and redirects old paths to items', () => {
    const rendered = renderSite(aSite());
    const paths = rendered.files.map((file) => file.path);
    expect(paths).toContain('posts/first/index.html');
    expect(paths).toContain('posts/tag/beta-tag/index.html');
    expect(JSON.parse(fileText(rendered.files, '_nix/redirects.json'))).toEqual({
      '/old/': '/posts/first/',
    });
  });

  it('refuses a tag page that would replace a published page', () => {
    const site = aSite();
    const pages = [
      ...site.pages,
      aPage({ itemId: 'clash', path: '/posts/tag/alpha/', parentItemId: 'posts', ordinal: 6 }),
    ];
    expect(() =>
      renderSite({ ...site, pages, manifest: { ...site.manifest, pageCount: pages.length } }),
    ).toThrow(/would replace a published page/);
  });
});
