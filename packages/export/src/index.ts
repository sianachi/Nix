/**
 * The Nix archive format.
 *
 * `.nix` is the lossless native export: an item, its properties, the schema and views it declares,
 * its document body, and its descendants, in one zip. ADR-0017 is the format's decision record and
 * this package is its only writer.
 *
 * **The item bundle outlives this one format.** Markdown, PDF and DOCX are lossy mappings of the
 * same bundle, and the reason they share it is so the block set has one place to be read rather
 * than four that drift. The exhaustive node visitor those mappers need now lives here too - it was
 * held back until it had a real first user rather than being guessed at, and `packages/pdf-export`
 * and `packages/docx-export` are that user.
 *
 * Three things a converter gets from this package and nowhere else: the bundle it reads
 * (`manifest.js`), the walk that guarantees it handled every block (`visit.js`), and the vocabulary
 * for what it could not carry (`loss.js`). `converter.js` is the interface a host runs it through,
 * shaped so MVP-9's plugin seam can adopt it unchanged.
 */

export { archiveFileName, exportFileName, writeArchive } from './archive.js';
export {
  EXPORT_FORMATS,
  createConverterRegistry,
  type Branding,
  type ConvertRequest,
  type ConverterRegistry,
  type DocumentConverter,
  type ExportFormat,
  type HostCapabilities,
  type LossNotice,
  type PrintPalette,
} from './converter.js';
export {
  LOSS_KINDS,
  createLossReport,
  type LossKind,
  type LossReport,
  type LossSink,
} from './loss.js';
export {
  PROSE_MARKS,
  PROSE_NODES,
  readBoolean,
  readNumber,
  readString,
  visitProse,
  type NodeHandler,
  type NodeHandlers,
  type ProseMark,
  type ProseMarkName,
  type ProseNode,
  type ProseNodeName,
  type VisitContext,
  type VisitRequest,
} from './visit.js';
export {
  ARCHIVE_FORMAT,
  ARCHIVE_FORMAT_VERSION,
  MANIFEST_ENTRY,
  TEMPLATE_PROFILE_VERSION,
  isArchiveSafeId,
  itemEntryName,
  type ArchiveItemEntry,
  type ArchiveManifest,
  type CanvasBody,
  type FilterRuleSnapshot,
  type FormBlockSnapshot,
  type FormConditionSnapshot,
  type FormPageSnapshot,
  type InteractiveFormSnapshot,
  type ItemBody,
  type ProseBody,
  type SheetBody,
  type TemplateArchiveProfile,
  type ItemBundle,
  type LossEntry,
  type Omission,
  type OmissionReason,
  type PropertyDefinition,
  type SchemaSnapshot,
  type ViewRowSnapshot,
  type ViewSnapshot,
  type ViewsSnapshot,
} from './manifest.js';
export {
  ArchiveReadError,
  TEMPLATE_ARCHIVE_LIMITS,
  TEMPLATE_IMPORT_REQUEST_BYTES,
  parseArchiveObject,
  parseStoredViewsObject,
  readArchive,
  requireTemplateProfile,
  validateTemplateArchive,
  type ArchiveReadLimits,
  type ReadArchiveOptions,
  type ReadArchiveResult,
} from './reader.js';
