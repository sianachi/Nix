import type { ItemBody } from '@nix/export';

import type { SitePage } from './manifest.js';

/**
 * Every file a site build needs: image nodes and captured Mermaid pictures (`codeBlock`
 * `renderFileId`) in published bodies, `nix-file:` property values on published pages, and the
 * targets of linked file blocks and inline references that are not pages (possible downloads).
 * The worker asks Core for exactly these and nothing else, and Core checks each against the
 * manifest (plan decision 1.3).
 */

export interface FileReference {
  readonly pageItemId: string;
  readonly fileItemId: string;
  /**
   * `embed` for a picture or a property file; `link` for a block or reference that names an item
   * which is not a published page. A `link` target is often not a file at all, so its absence is
   * not worth reporting: the page already says the link was kept as text.
   */
  readonly kind: 'embed' | 'link';
}

const NIX_FILE = /^nix-file:([0-9a-zA-Z-]{1,64})$/;

function filesIn(
  node: unknown,
  found: Set<string>,
  linked: Set<string>,
  pages: ReadonlySet<string>,
): void {
  if (typeof node !== 'object' || node === null) {
    return;
  }
  const record = node as { type?: unknown; attrs?: unknown; content?: unknown };
  if (typeof record.attrs === 'object' && record.attrs !== null) {
    const attrs = record.attrs as Record<string, unknown>;
    const id =
      record.type === 'image'
        ? attrs.fileItemId
        : record.type === 'codeBlock' &&
            typeof attrs.language === 'string' &&
            attrs.language.trim().toLowerCase() === 'mermaid'
          ? attrs.renderFileId
          : null;
    if (typeof id === 'string' && id.length > 0) {
      found.add(id);
    }
    const target =
      record.type === 'itemBlock' ||
      (record.type === 'reference' && (attrs.kind ?? 'item') === 'item')
        ? attrs.targetId
        : null;
    if (typeof target === 'string' && target.length > 0 && !pages.has(target)) {
      linked.add(target);
    }
  }
  if (Array.isArray(record.content)) {
    for (const child of record.content) {
      filesIn(child, found, linked, pages);
    }
  }
}

export function collectFileReferences(
  pages: readonly SitePage[],
  bodies: ReadonlyMap<string, ItemBody | null>,
): FileReference[] {
  const references: FileReference[] = [];
  const pageIds = new Set(pages.map((page) => page.itemId));
  for (const page of pages) {
    const found = new Set<string>();
    const linked = new Set<string>();
    const body = bodies.get(page.itemId);
    if (body !== null && body !== undefined && 'prosemirror' in body) {
      filesIn(body.prosemirror, found, linked, pageIds);
    }
    for (const value of Object.values(page.properties)) {
      for (const entry of Array.isArray(value) ? value : [value]) {
        const match = typeof entry === 'string' ? NIX_FILE.exec(entry) : null;
        if (match?.[1] !== undefined) {
          found.add(match[1]);
        }
      }
    }
    for (const fileItemId of [...new Set([...found, ...linked])].sort()) {
      references.push({
        pageItemId: page.itemId,
        fileItemId,
        kind: found.has(fileItemId) ? 'embed' : 'link',
      });
    }
  }
  return references;
}
