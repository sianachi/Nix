import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import type { ItemBody } from '@nix/export';

import { downloadType, prepareDownload, type PublishedDownload } from './downloads.js';
import { stripImageMetadata, type StrippedImage } from './images.js';
import { parseSiteManifest, parseSitePages } from './manifest.js';
import { collectFileReferences } from './references.js';
import type { RenderSiteInput, RenderedFile } from './render.js';

/**
 * A site build from a directory instead of Core, for previews and tests:
 *
 * ```
 * manifest.json                 the build manifest
 * pages.json                    its pages
 * bodies/<itemId>.json          each page's ItemBody, when it has one
 * files/<fileItemId>.<ext>      file bytes, jpg, png, webp or svg; pdf, txt or csv downloads
 * files/names.json              optional: a download's file name by file item, as Core names it
 * ```
 *
 * Files are read only when a page references them, as the worker does.
 */

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
};

export async function loadFixture(dir: string): Promise<RenderSiteInput> {
  const manifest = parseSiteManifest(
    JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')),
  );
  const pages = parseSitePages(
    JSON.parse(await readFile(join(dir, 'pages.json'), 'utf8')),
    manifest,
  );

  const bodies = new Map<string, ItemBody | null>();
  for (const page of pages) {
    const path = join(dir, 'bodies', `${page.itemId}.json`);
    bodies.set(
      page.itemId,
      existsSync(path) ? (JSON.parse(await readFile(path, 'utf8')) as ItemBody) : null,
    );
  }

  const files = existsSync(join(dir, 'files')) ? await readdir(join(dir, 'files')) : [];
  const names = (
    files.includes('names.json')
      ? JSON.parse(await readFile(join(dir, 'files', 'names.json'), 'utf8'))
      : {}
  ) as Record<string, string>;
  const assets = new Map<string, StrippedImage>();
  const downloads = new Map<string, PublishedDownload>();
  for (const { fileItemId } of collectFileReferences(pages, bodies)) {
    if (assets.has(fileItemId) || downloads.has(fileItemId)) {
      continue;
    }
    const name = files.find((file) => file.slice(0, file.lastIndexOf('.')) === fileItemId);
    const mediaType =
      name === undefined
        ? undefined
        : MEDIA_TYPES[name.slice(name.lastIndexOf('.') + 1).toLowerCase()];
    if (name === undefined || mediaType === undefined) {
      continue; // the page renders a notice and the build reports the missing image
    }
    const bytes = new Uint8Array(await readFile(join(dir, 'files', name)));
    if (downloadType(mediaType) !== null) {
      downloads.set(fileItemId, prepareDownload(bytes, mediaType, names[fileItemId] ?? name));
    } else {
      assets.set(fileItemId, stripImageMetadata(bytes, mediaType));
    }
  }

  return { manifest, pages, bodies, assets, downloads };
}

/**
 * Writes rendered files under `outDir`. An existing directory is replaced only when it holds a
 * previous build (`_nix/build.json`), so a mistyped path cannot wipe something else.
 */
export async function writeSite(files: readonly RenderedFile[], outDir: string): Promise<void> {
  const root = resolve(outDir);
  if (existsSync(root)) {
    const entries = await readdir(root);
    if (entries.length > 0 && !existsSync(join(root, '_nix', 'build.json'))) {
      throw new Error(
        `${root} is not empty and does not hold a site build; refusing to replace it.`,
      );
    }
    await rm(root, { recursive: true, force: true });
  }
  for (const file of files) {
    const target = resolve(root, file.path);
    if (!target.startsWith(root + sep)) {
      throw new Error(`Refusing to write outside ${root}: ${file.path}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.bytes);
  }
}
