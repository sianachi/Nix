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
export { nixExtensions } from './extensions.js';
export {
  SCHEMA_VERSION,
  countNodes,
  emptyDocument,
  nixSchema,
  parseDocument,
  type ParseResult,
} from './schema.js';
export { FIXTURE_DOCUMENT, MARK_FIXTURES, NODE_FIXTURES } from './fixtures.js';
