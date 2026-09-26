import type { Problem } from '../validate/report.js';

/**
 * One node of a previewed change tree (architecture section 7): what would exist, in plain words,
 * never JSX and never raw JSON. `why` is model-authored (a `FieldSpec`/`ViewSpec`/`Node`'s own
 * `why`) and is rendered as plain text only - it is advisory, never structural, so a node with no
 * `why` is exactly as valid as one with one.
 */
export interface PreviewNode {
  label: string;
  detail: string[];
  why?: string;
  children: PreviewNode[];
}

/**
 * What `@nix/structure-spec/describe` and `@nix/companion`'s `describeToolCall` hand back for a
 * pending tool call: a first-person headline, where it lands, enough counts for a summary line
 * without the caller re-deriving them, the change tree itself, and the fixed list of writes this
 * executor never performs (architecture section 7, "Approval UX architecture"). `problems` (from
 * `ValidationReport`) block approval; `warnings` do not. Every string here is plain text - the
 * renderer (`apps/web/src/pets/pet-structure-preview.tsx`, task A.6) never runs Markdown or
 * `dangerouslySetInnerHTML` over any of it, because every string in this model may have been
 * chosen by the model that proposed the change.
 */
export interface PreviewModel {
  headline: string;
  destination: { title: string; path: string[] };
  counts: { items: number; fields: number; views: number; entries: number; writes: number };
  tree: PreviewNode[];
  notes: string[];
  warnings: Problem[];
  problems: Problem[];
  neverDoes: string[];
}
