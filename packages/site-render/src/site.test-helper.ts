import type { ItemBody, ViewsSnapshot } from '@nix/export';

import type { SiteBuildManifest, SitePage } from './manifest.js';
import type { RenderSiteInput } from './render.js';

/** A small site built in code, for tests that need one page or three. Test-only. */

export function aManifest(overrides: Partial<SiteBuildManifest> = {}): SiteBuildManifest {
  return {
    formatVersion: 1,
    siteId: 'site',
    buildId: 'build',
    workspaceId: 'ws',
    rootItemId: 'root',
    layout: 'blog',
    settings: {
      name: 'Test site',
      description: 'A site for tests.',
      accent: SAMPLE_ACCENT,
      navigation: [],
      footerText: '',
      builtWithNix: true,
      language: 'en',
      noindex: false,
    },
    canonicalOrigin: 'https://example.test',
    builtAt: '2026-10-11T12:00:00Z',
    pageCount: 1,
    datedCollections: [],
    redirects: [],
    ...overrides,
  };
}

export const SAMPLE_ACCENT = '#336699'; // design-token-exempt: a site setting as Core stores it, not a theme colour.

export function aPage(overrides: Partial<SitePage> & Pick<SitePage, 'itemId' | 'path'>): SitePage {
  return {
    ordinal: 0,
    parentItemId: null,
    title: overrides.itemId,
    type: 'note',
    seq: '0',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    properties: {},
    schema: null,
    views: null,
    chart: null,
    content: null,
    datedCollectionId: null,
    publishedAt: null,
    propertyFiles: [],
    ...overrides,
  };
}

export function prose(...content: unknown[]): ItemBody {
  return { schemaVersion: 5, prosemirror: { type: 'doc', content } };
}

export function paragraph(text: string): unknown {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

export function listViews(kind = 'list'): ViewsSnapshot {
  return {
    default: 'v',
    views: [
      {
        id: 'v',
        name: 'Children',
        kind,
        columns: [],
        groupBy: kind === 'board' ? 'status' : null,
        groupOrder: [],
        dateProperty: null,
        sortBy: null,
        sortDescending: false,
        mode: null,
        coverProperty: null,
        endDateProperty: null,
        cardSize: null,
      },
    ],
  };
}

/** A root, a dated "posts" collection with two entries, and a plain page with a list view. */
export function aSite(layout: 'blog' | 'docs' = 'blog'): RenderSiteInput {
  const pages: SitePage[] = [
    aPage({ itemId: 'root', path: '/', title: 'Home', ordinal: 0 }),
    aPage({ itemId: 'posts', path: '/posts/', title: 'Posts', parentItemId: 'root', ordinal: 1 }),
    aPage({
      itemId: 'p1',
      path: '/posts/first/',
      title: 'First post',
      parentItemId: 'posts',
      ordinal: 2,
      datedCollectionId: 'posts',
      publishedAt: '2026-03-01',
      properties: { tags: ['alpha', 'Beta Tag'] },
    }),
    aPage({
      itemId: 'p2',
      path: '/posts/second/',
      title: 'Second post',
      parentItemId: 'posts',
      ordinal: 3,
      datedCollectionId: 'posts',
      publishedAt: '2026-05-01',
      properties: { tags: ['alpha'] },
    }),
    aPage({
      itemId: 'lists',
      path: '/lists/',
      title: 'Lists',
      parentItemId: 'root',
      ordinal: 4,
      views: listViews(),
    }),
    aPage({
      itemId: 'l1',
      path: '/lists/one/',
      title: 'List one',
      parentItemId: 'lists',
      ordinal: 5,
    }),
  ];
  const bodies = new Map<string, ItemBody | null>([
    ['root', prose(paragraph('Welcome home.'))],
    ['p1', prose(paragraph('Zebra crossing words.'))],
    ['p2', prose(paragraph('Unicorn sightings.'))],
  ]);
  return {
    manifest: aManifest({
      layout,
      pageCount: pages.length,
      datedCollections: [
        {
          itemId: 'posts',
          dateProperty: 'date',
          tagsProperty: 'tags',
          coverProperty: null,
          summaryProperty: null,
        },
      ],
      redirects: [{ from: '/old/', toItemId: 'p1' }],
    }),
    pages,
    bodies,
    assets: new Map(),
  };
}

export function fileText(
  files: readonly { path: string; bytes: Uint8Array }[],
  path: string,
): string {
  const file = files.find((entry) => entry.path === path);
  if (file === undefined) {
    throw new Error(`no file ${path}`);
  }
  return new TextDecoder().decode(file.bytes);
}
