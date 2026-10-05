import {
  ARCHIVE_FORMAT_VERSION,
  FILE_ARCHIVE_FORMAT_VERSION,
  MAX_ARCHIVE_FILE_VERSIONS_PER_ITEM,
  isArchiveSafeId,
  type ArchiveFileVersionEntry,
  type ArchiveManifest,
  type ItemBody,
  type ItemBundle,
} from './manifest.js';

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

/** Validates the versioned file metadata before a writer emits the manifest. */
export function assertManifestHasNoUnportableFiles(manifest: ArchiveManifest): void {
  const fileItems = manifest.items.filter((item) => item.type.toLowerCase() === 'file');
  const descriptors = manifest.files ?? [];
  if (manifest.formatVersion === ARCHIVE_FORMAT_VERSION) {
    if (descriptors.length > 0) {
      throw new ArchiveFileBytesUnsupportedError(
        'Nix archive v1 cannot declare file-byte entries.',
      );
    }
    const file = fileItems[0];
    if (file !== undefined) {
      throw new ArchiveFileBytesUnsupportedError(
        `Nix archive v1 cannot export file item ${file.id} losslessly because it has no file-byte entry format.`,
      );
    }
    return;
  }
  if (manifest.formatVersion !== FILE_ARCHIVE_FORMAT_VERSION) {
    throw new ArchiveFileBytesUnsupportedError(
      `Nix archive format version ${String(manifest.formatVersion)} is not supported by this writer.`,
    );
  }
  if (manifest.files === undefined) {
    throw new ArchiveFileBytesUnsupportedError('Nix archive v2 must declare its file versions.');
  }
  validateFileVersionEntries(descriptors);

  const fileItemIds = new Set(fileItems.map((item) => item.id));
  const describedIds = new Set(descriptors.map((entry) => entry.itemId));
  if (
    fileItemIds.size !== describedIds.size ||
    [...fileItemIds].some((id) => !describedIds.has(id))
  ) {
    throw new ArchiveFileBytesUnsupportedError(
      'Nix archive v2 must include file bytes for every file item and no other items.',
    );
  }
}

/** Validates file references after their target descriptors are known. */
export function assertBundleHasNoUnportableFiles(
  bundle: ItemBundle,
  formatVersion = ARCHIVE_FORMAT_VERSION,
  fileItemIds: ReadonlySet<string> = new Set(),
): void {
  if (formatVersion === ARCHIVE_FORMAT_VERSION && bundle.type.toLowerCase() === 'file') {
    throw new ArchiveFileBytesUnsupportedError(
      `Nix archive v1 cannot export file item ${bundle.id} losslessly because it has no file-byte entry format.`,
    );
  }

  const references = durableFileReferences(bundle.body);
  if (formatVersion === ARCHIVE_FORMAT_VERSION && references.length > 0) {
    throw new ArchiveFileBytesUnsupportedError(
      `Nix archive v1 cannot export item ${bundle.id} losslessly because its body contains a durable file reference but the archive has no file-byte entry format.`,
    );
  }
  const missing = references.find((itemId) => !fileItemIds.has(itemId));
  if (formatVersion === FILE_ARCHIVE_FORMAT_VERSION && missing !== undefined) {
    throw new ArchiveFileBytesUnsupportedError(
      `Nix archive v2 cannot export item ${bundle.id} because referenced file item ${missing} is not included.`,
    );
  }
}

export function validateFileVersionEntries(entries: readonly ArchiveFileVersionEntry[]): void {
  const byItem = new Map<string, ArchiveFileVersionEntry[]>();
  for (const entry of entries) {
    if (
      !isArchiveSafeId(entry.itemId) ||
      !Number.isSafeInteger(entry.version) ||
      entry.version < 1 ||
      entry.version > MAX_ARCHIVE_FILE_VERSIONS_PER_ITEM ||
      typeof entry.current !== 'boolean' ||
      !validFileName(entry.fileName) ||
      !validMediaType(entry.mediaType) ||
      !Number.isSafeInteger(entry.byteLength) ||
      entry.byteLength < 0 ||
      entry.byteLength > 100 * 1024 * 1024 ||
      !/^[0-9a-f]{64}$/.test(entry.sha256) ||
      typeof entry.previewable !== 'boolean' ||
      !validDimensions(entry)
    ) {
      throw new ArchiveFileBytesUnsupportedError(
        'Nix archive v2 contains invalid file-version metadata.',
      );
    }
    const versions = byItem.get(entry.itemId) ?? [];
    if (versions.some((candidate) => candidate.version === entry.version)) {
      throw new ArchiveFileBytesUnsupportedError(
        'Nix archive v2 contains a duplicate file version.',
      );
    }
    versions.push(entry);
    byItem.set(entry.itemId, versions);
  }

  for (const versions of byItem.values()) {
    versions.sort((left, right) => left.version - right.version);
    if (
      versions.length > MAX_ARCHIVE_FILE_VERSIONS_PER_ITEM ||
      versions.some((entry, index) => entry.version !== index + 1) ||
      versions.filter((entry) => entry.current).length !== 1 ||
      versions.at(-1)?.current !== true
    ) {
      throw new ArchiveFileBytesUnsupportedError(
        'Nix archive v2 file versions must be contiguous and have exactly one current, newest version.',
      );
    }
  }
}

function validFileName(value: string): boolean {
  if (
    value.trim().length === 0 ||
    value.length > 255 ||
    value.includes('/') ||
    value.includes('\\')
  ) {
    return false;
  }
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function validMediaType(value: string): boolean {
  const separator = value.indexOf('/');
  return (
    separator > 0 &&
    separator < value.length - 1 &&
    value.length <= 160 &&
    /^[\x21-\x7e]+$/.test(value) &&
    !/[;\\]/.test(value)
  );
}

function validDimensions(entry: ArchiveFileVersionEntry): boolean {
  if (entry.pixelWidth === null && entry.pixelHeight === null) {
    // Bounded PDFs can be previewable without raster dimensions; the worker owns the MIME proof.
    return (
      !entry.previewable ||
      (entry.mediaType === 'application/pdf' && entry.byteLength <= 10 * 1024 * 1024)
    );
  }
  const width = entry.pixelWidth;
  const height = entry.pixelHeight;
  if (
    width === null ||
    height === null ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width * height > 1_000_000_000
  ) {
    return false;
  }
  return (
    !entry.previewable || (entry.byteLength < 10 * 1024 * 1024 && width * height <= 40_000_000)
  );
}

function durableFileReferences(body: ItemBody | null): string[] {
  if (body === null) return [];

  if ('prosemirror' in body) return proseDurableFileReferences(body.prosemirror);
  if ('canvas' in body) return canvasDurableFileReferences(body.canvas);
  return [];
}

function proseDurableFileReferences(document: unknown): string[] {
  const pending: unknown[] = [document];
  const references = new Set<string>();

  while (pending.length > 0) {
    const value = pending.pop();
    const node = record(value);
    if (node === null) continue;

    if (node.type === 'image') {
      const attributes = record(node.attrs);
      const fileItemId = attributes?.fileItemId;
      const source = attributes?.src;
      if (nonEmptyString(fileItemId)) references.add(fileItemId);
      if (typeof source === 'string' && source.startsWith(NIX_FILE_SOURCE_PREFIX)) {
        const sourceId = source.slice(NIX_FILE_SOURCE_PREFIX.length);
        if (nonEmptyString(sourceId)) references.add(sourceId);
      }
    }

    if (Array.isArray(node.content)) pushAll(pending, node.content);
  }

  return [...references];
}

function canvasDurableFileReferences(scene: unknown): string[] {
  const elements = record(scene)?.elements;
  const values = Array.isArray(elements) ? elements : Object.values(record(elements) ?? {});
  const references = new Set<string>();

  for (const value of values) {
    const element = record(value);
    if (element === null) continue;

    const marker = record(record(element.customData)?.nix);
    if (marker?.kind === 'file' && nonEmptyString(marker.itemId)) references.add(marker.itemId);

    // Temporary native-canvas documents used this field before the canonical customData marker.
    if (element.type === 'image' && nonEmptyString(element.imageItemId))
      references.add(element.imageItemId);
  }

  return [...references];
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
