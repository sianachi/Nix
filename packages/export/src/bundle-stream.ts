import { ARCHIVE_FORMAT, type ArchiveManifest, type ItemBundle } from './manifest.js';

/**
 * Reads collab's bundle stream: the manifest on the first line, one bundle per line, then the
 * `{"end":true,"items":N}` sentinel (see `apps/collab/src/export/ndjson.ts`).
 *
 * **A stream without its sentinel is refused.** A truncated NDJSON stream is still a run of valid
 * lines, so accepting one would publish a silently incomplete site. The count is checked against
 * the bundles read, and blank lines (a trailing newline) are skipped.
 *
 * Shapes are checked structurally, not deeply: the manifest must name the archive format and each
 * bundle must carry an id. A body is drawn later through `visitProse`, which tolerates anything.
 */

export class BundleStreamError extends Error {
  override readonly name = 'BundleStreamError';
}

export interface BundleStream {
  readonly manifest: ArchiveManifest;
  readonly bundles: readonly ItemBundle[];
}

export function readBundleStream(lines: Iterable<string>): BundleStream {
  let manifest: ArchiveManifest | null = null;
  const bundles: ItemBundle[] = [];
  let ended = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) {
      continue;
    }
    if (ended) {
      throw new BundleStreamError('The bundle stream continues after its end marker.');
    }

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new BundleStreamError('The bundle stream holds a line that is not JSON.');
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new BundleStreamError('The bundle stream holds a line that is not an object.');
    }
    const record = value as Record<string, unknown>;

    if (manifest === null) {
      if (record.format !== ARCHIVE_FORMAT || !Array.isArray(record.items)) {
        throw new BundleStreamError('The bundle stream does not start with an archive manifest.');
      }
      manifest = record as unknown as ArchiveManifest;
      continue;
    }

    if (record.end === true) {
      if (record.items !== bundles.length) {
        throw new BundleStreamError(
          `The bundle stream says it holds ${String(record.items)} bundles but carried ${String(bundles.length)}.`,
        );
      }
      ended = true;
      continue;
    }

    if (typeof record.id !== 'string') {
      throw new BundleStreamError('The bundle stream holds a bundle without an id.');
    }
    bundles.push(record as unknown as ItemBundle);
  }

  if (manifest === null) {
    throw new BundleStreamError('The bundle stream is empty.');
  }
  if (!ended) {
    throw new BundleStreamError('The bundle stream ended before its end marker.');
  }
  return { manifest, bundles };
}
