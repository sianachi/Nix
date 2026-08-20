/**
 * Counting what an import carries but cannot resolve.
 *
 * A Markdown source can reference things only its home understood: `[[wiki links]]` into another
 * vault, images by local file path. Import carries them as text rather than resolving them, and
 * the mapping report must say how many, per file - a declared loss, never a silent one. The
 * counting is one definition here, shared by the CLI and the web dialog, so the two reports cannot
 * disagree about what "unresolved" means. Browser-safe by construction: no Node imports, and light
 * enough to load without the Markdown mapping (see the `./scan` subpath export).
 */

/** Wiki links are carried as plain text, not resolved. */
const WIKI_LINK = /\[\[[^\]]+\]\]/g;

/** Every Markdown image; the ones whose target has no scheme point at local files. */
const IMAGE = /!\[[^\]]*\]\(\s*([^)\s]+)[^)]*\)/g;

/** `http:`, `nix:`, `data:`... - a target with a scheme is an address, not a local path. */
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** How many `[[wiki links]]` a body carries; each is kept as text rather than resolved. */
export function countWikiLinks(body: string): number {
  return body.match(WIKI_LINK)?.length ?? 0;
}

/** How many image references point at local files - addresses the workspace cannot reach. */
export function countLocalImages(body: string): number {
  let count = 0;
  for (const match of body.matchAll(IMAGE)) {
    const target = match[1];
    if (target !== undefined && !HAS_SCHEME.test(target)) {
      count += 1;
    }
  }
  return count;
}
