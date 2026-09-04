import type { ArchiveManifest, ItemBody, ItemBundle } from './manifest.js';

/** Machine-readable reason a native archive was refused instead of written with missing bytes. */
export const ARCHIVE_FILE_BYTES_UNSUPPORTED = 'archive.file_bytes_unsupported';

const NIX_FILE_SOURCE_PREFIX = 'nix-file:';

/**
 * Archive v1 has no entry that can carry a file item's bytes.
 *
 * Refusing the archive is intentional: `.nix` is advertised as lossless, so completing an archive
 * that only preserved the file item's metadata or a document reference would be data loss hidden
 * behind a successful export.
 */
export class ArchiveFileBytesUnsupportedError extends Error {
  readonly code = ARCHIVE_FILE_BYTES_UNSUPPORTED;

  constructor(message: string) {
    super(message);
    this.name = 'ArchiveFileBytesUnsupportedError';
  }
}

/** Refuses file items before a writer emits the manifest (and therefore before its first byte). */
export function assertManifestHasNoUnportableFiles(manifest: ArchiveManifest): void {
  const file = manifest.items.find((item) => item.type === 'file');
  if (file === undefined) return;

  throw new ArchiveFileBytesUnsupportedError(
    `Nix archive v1 cannot export file item ${file.id} losslessly because it has no file-byte entry format.`,
  );
}

/** Refuses a file bundle or a body whose durable references would arrive without their bytes. */
export function assertBundleHasNoUnportableFiles(bundle: ItemBundle): void {
  if (bundle.type === 'file') {
    throw new ArchiveFileBytesUnsupportedError(
      `Nix archive v1 cannot export file item ${bundle.id} losslessly because it has no file-byte entry format.`,
    );
  }

  if (!bodyHasDurableFileReference(bundle.body)) return;

  throw new ArchiveFileBytesUnsupportedError(
    `Nix archive v1 cannot export item ${bundle.id} losslessly because its body contains a durable file reference but the archive has no file-byte entry format.`,
  );
}

function bodyHasDurableFileReference(body: ItemBody | null): boolean {
  if (body === null) return false;

  if ('prosemirror' in body) return proseHasDurableFileReference(body.prosemirror);
  if ('canvas' in body) return canvasHasDurableFileReference(body.canvas);
  return false;
}

function proseHasDurableFileReference(document: unknown): boolean {
  const pending: unknown[] = [document];

  while (pending.length > 0) {
    const value = pending.pop();
    const node = record(value);
    if (node === null) continue;

    if (node.type === 'image') {
      const attributes = record(node.attrs);
      const fileItemId = attributes?.fileItemId;
      const source = attributes?.src;
      if (
        nonEmptyString(fileItemId) ||
        (typeof source === 'string' &&
          source.startsWith(NIX_FILE_SOURCE_PREFIX) &&
          source.length > NIX_FILE_SOURCE_PREFIX.length)
      ) {
        return true;
      }
    }

    if (Array.isArray(node.content)) pushAll(pending, node.content);
  }

  return false;
}

function canvasHasDurableFileReference(scene: unknown): boolean {
  const elements = record(scene)?.elements;
  const values = Array.isArray(elements) ? elements : Object.values(record(elements) ?? {});

  for (const value of values) {
    const element = record(value);
    if (element === null) continue;

    const marker = record(record(element.customData)?.nix);
    if (marker?.kind === 'file' && nonEmptyString(marker.itemId)) return true;

    // Temporary native-canvas documents used this field before the canonical customData marker.
    if (element.type === 'image' && nonEmptyString(element.imageItemId)) return true;
  }

  return false;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pushAll(queue: unknown[], values: readonly unknown[]): void {
  for (const value of values) queue.push(value);
}
