/**
 * The Nix archive format.
 *
 * `.nix` is the lossless native export: an item, its properties, the schema and views it declares,
 * its document body, and its descendants, in one zip. ADR-0017 is the format's decision record and
 * this package is its only writer.
 *
 * **The item bundle is meant to outlive this one format.** Markdown, PDF and DOCX are lossy
 * mappings of the same bundle, and the reason they share it is so the block set has one place to be
 * read rather than four that drift. What is deliberately *not* here yet is the exhaustive node
 * visitor those mappers need: `.nix` stores ProseMirror JSON verbatim and has no use for it, and an
 * abstraction with no implementation is a guess at what its first user will want.
 */

export { archiveFileName, writeArchive } from './archive.js';
export {
  ARCHIVE_FORMAT,
  ARCHIVE_FORMAT_VERSION,
  MANIFEST_ENTRY,
  isArchiveSafeId,
  itemEntryName,
  type ArchiveItemEntry,
  type ArchiveManifest,
  type ItemBody,
  type ProseBody,
  type SheetBody,
  type ItemBundle,
  type LossEntry,
  type Omission,
  type OmissionReason,
  type PropertyDefinition,
  type SchemaSnapshot,
  type ViewSnapshot,
  type ViewsSnapshot,
} from './manifest.js';
