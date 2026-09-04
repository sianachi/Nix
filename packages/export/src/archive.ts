import { Zip, ZipDeflate } from 'fflate';

import {
  ARCHIVE_FORMAT,
  MANIFEST_ENTRY,
  isArchiveSafeId,
  itemEntryName,
  type ArchiveManifest,
  type ItemBundle,
} from './manifest.js';
import {
  assertBundleHasNoUnportableFiles,
  assertManifestHasNoUnportableFiles,
} from './file-portability.js';

/**
 * Writes a `.nix` archive as a stream of chunks.
 *
 * **The manifest is written first**, before any payload, so a reader has the tree before it has the
 * bodies. That is what lets a large archive be read without being held: a zip's central directory
 * is at the end, so an archive whose structure lived only there could not be streamed at all.
 *
 * **The caller supplies the manifest up front and the bundles lazily.** Enumerating the tree is
 * metadata-only and cheap; fetching bodies is neither. Separating them is what keeps this writer's
 * memory bounded by one item rather than by the size of the export - and it is why ADR-0017 puts
 * parentage and sibling order on the manifest spine rather than nesting children inside parents.
 *
 * **A failure part-way through truncates rather than completes.** Once the first byte is out there
 * is no status code left to change, so a bundle that cannot be produced ends the stream without the
 * central directory. The result does not open, which is the honest outcome - an archive that opens
 * and is quietly missing items would be a lie about the one property this format sells.
 */
export async function* writeArchive(input: {
  readonly manifest: ArchiveManifest;
  readonly bundles: AsyncIterable<ItemBundle>;
}): AsyncGenerator<Uint8Array> {
  const { manifest, bundles } = input;

  if (manifest.format !== ARCHIVE_FORMAT) {
    throw new Error(`An archive manifest must declare format '${ARCHIVE_FORMAT}'.`);
  }

  // Archive v1 has no file-byte entry. Check the manifest before constructing the zip so a file
  // item produces no plausible prefix at all; a later body reference still leaves the zip open.
  assertManifestHasNoUnportableFiles(manifest);

  // A holder rather than a bare `let`: the callback below assigns it, which the compiler cannot
  // see, so a plain variable would be narrowed to null at every read and the check would compile
  // to nothing.
  const state: { failure: Error | null } = { failure: null };
  const queue: Uint8Array[] = [];

  const zip = new Zip((error, chunk) => {
    if (error !== null) {
      state.failure = error;
      return;
    }

    if (chunk.length > 0) {
      queue.push(chunk);
    }
  });

  // Every entry carries the export's own timestamp rather than the clock. An archive of unchanged
  // content should be byte-identical to the last one, which is what makes the round-trip test in
  // this package an equality assertion instead of a structural one.
  const mtime = new Date(manifest.exportedAt);

  const expected = new Set(manifest.items.map((entry) => entry.id));
  const written = new Set<string>();

  yield* addEntry(zip, queue, state, MANIFEST_ENTRY, encodeJson(manifest), mtime);

  for await (const bundle of bundles) {
    if (!isArchiveSafeId(bundle.id)) {
      throw new Error(`'${bundle.id}' is not a usable item identifier for an archive entry.`);
    }

    if (!expected.has(bundle.id)) {
      throw new Error(`The bundle for ${bundle.id} has no entry in the manifest.`);
    }

    if (written.has(bundle.id)) {
      throw new Error(`The bundle for ${bundle.id} was produced twice.`);
    }

    assertBundleHasNoUnportableFiles(bundle);

    written.add(bundle.id);
    yield* addEntry(zip, queue, state, itemEntryName(bundle.id), encodeJson(bundle), mtime);
  }

  if (written.size !== expected.size) {
    // Deliberately before `zip.end()`, so the archive is never closed around a missing payload.
    throw new Error(
      `The manifest lists ${String(expected.size)} items but ${String(written.size)} were written. The archive would claim to be complete and would not be.`,
    );
  }

  zip.end();
  yield* drain(queue, state);
}

/** Adds one entry and yields whatever the zip emitted for it. */
function* addEntry(
  zip: Zip,
  queue: Uint8Array[],
  state: { failure: Error | null },
  name: string,
  bytes: Uint8Array,
  mtime: Date,
): Generator<Uint8Array> {
  const entry = new ZipDeflate(name, { level: 6 });
  entry.mtime = mtime;

  zip.add(entry);

  // `ZipDeflate` compresses synchronously, so by the time push returns the archive's callback has
  // already run and the queue holds this entry's bytes. Nothing here waits on a worker.
  entry.push(bytes, true);

  yield* drain(queue, state);
}

/** Hands over whatever the zip has produced so far, newest failure first. */
function* drain(queue: Uint8Array[], state: { failure: Error | null }): Generator<Uint8Array> {
  if (state.failure !== null) {
    throw state.failure;
  }

  // Spliced rather than iterated and cleared: the callback can append while this runs, and taking
  // the buffer wholesale means a chunk arriving mid-drain is carried to the next one rather than
  // dropped.
  const chunks = queue.splice(0, queue.length);
  for (const chunk of chunks) {
    yield chunk;
  }
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/**
 * A file name for an exported item, in the given format.
 *
 * Punctuation a file system argues about is replaced rather than stripped, so two items whose
 * titles differ only in it do not collapse to the same name. An item titled only in punctuation
 * falls back to a fixed name instead of producing a dotfile or an empty one.
 *
 * The extension carries no dot - it comes from a converter's `extension`, which does not carry one
 * either - and a leading dot is stripped rather than trusted, because a convention that is
 * documented and unenforced is one that produces `report..pdf` the first time somebody follows the
 * shape of the argument instead of the sentence describing it.
 */
export function exportFileName(title: string, extension: string): string {
  const slug = title
    .normalize('NFKD')
    .replaceAll(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 60)
    .toLowerCase();

  return `${slug === '' ? 'export' : slug}.${extension.replace(/^\.+/, '')}`;
}

/**
 * The `.nix` case, which is what ADR-0017's writer names.
 *
 * Kept beside {@link exportFileName} rather than folded into it because `.nix` is the one format
 * whose extension is a property of this package rather than a caller's choice.
 */
export function archiveFileName(title: string): string {
  return exportFileName(title, 'nix');
}
