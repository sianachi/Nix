/**
 * The Nix document schema.
 *
 * One definition of what a document may contain, imported by the web editor to build the
 * editor and by the collaboration service to check that an accepted update still produces
 * a document that parses. Two definitions of the same schema is the failure this package
 * exists to prevent: documents that save on one side and refuse to open on the other.
 */

export type {} from './augmentations.js';
export { CALLOUT_TONES, Callout, type CalloutTone } from './callout.js';
export { Column, ColumnBlock, MAX_COLUMNS } from './columns.js';
export {
  Details,
  DetailsContent,
  DetailsSummary,
  TOGGLE_LEVELS,
  type ToggleLevel,
} from './details.js';
export { CommentMark, TEXT_COLORS, TextColorMark, type TextColor } from './marks.js';
export { REFERENCE_KINDS, Reference, type ReferenceKind } from './references.js';
export { nixExtensions } from './extensions.js';
export {
  SCHEMA_VERSION,
  countNodes,
  emptyDocument,
  nixSchema,
  parseDocument,
  type ParseResult,
} from './schema.js';
export { FIXTURE_DOCUMENT, MARK_FIXTURES, NODE_FIXTURES, VERSION_1_DOCUMENT } from './fixtures.js';
export {
  BASE_SCHEMA_VERSION,
  MARK_MIN_VERSION,
  MIN_VERSIONS,
  NODE_MIN_VERSION,
  requiredSchemaVersion,
  type MinimumVersions,
} from './versions.js';
