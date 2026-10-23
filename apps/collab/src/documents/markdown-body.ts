/**
 * A note body, read and written as Markdown, inside the collaboration service.
 *
 * This is the server-side counterpart of `nixctl note write` (`apps/cli/src/body.ts`) and of the
 * companion's append (`packages/companion/src/bodies.ts`). Replace applies the parsed document
 * with `updateYFragment`, the same minimal diff the web editor's binding uses, so a one-word
 * edit is a one-word Yjs update and concurrent edits merge instead of being overwritten. Append
 * clones the new blocks onto the end and does not reserialise the existing fragment, so marks
 * Markdown cannot carry survive an append.
 *
 * The caller posts the resulting update through {@link applyUpdate} and then refreshes any
 * resident session, which is what makes a person who has the note open see the change.
 */

import { nixSchema } from '@nix/editor-schema';
import {
  documentToMarkdown,
  EMPTY_MARKDOWN_IMPORT_SCAN,
  markdownToDocument,
  type MarkdownImportScan,
  type MarkdownLoss,
} from '@nix/markdown';
import {
  prosemirrorJSONToYXmlFragment,
  updateYFragment,
  yXmlFragmentToProseMirrorRootNode,
} from 'y-prosemirror';
import * as Y from 'yjs';

import { FRAGMENT_NAME } from './body-kinds.ts';

/**
 * How much Markdown one request may carry.
 *
 * The same ceiling `nixctl mcp`'s note-write tool publishes. A longer body is refused before it
 * is parsed. Core's REST route uses this number too; the two must move together.
 */
export const MARKDOWN_CHAR_LIMIT = 200_000;

export type MarkdownWriteMode = 'replace' | 'append';

export interface MarkdownRead {
  readonly markdown: string;
  readonly losses: readonly MarkdownLoss[];

  /** True when the fragment has no blocks yet - a note nobody has edited, not an error. */
  readonly empty: boolean;
}

export type MarkdownDelta =
  | {
      readonly ok: true;
      readonly update: Uint8Array;
      readonly scan: MarkdownImportScan;
    }
  | { readonly ok: false; readonly reason: string; readonly tooLong?: boolean };

/** Renders the prose fragment. An empty fragment is an empty note, not a parse failure. */
export function readMarkdown(doc: Y.Doc): MarkdownRead {
  const fragment = doc.getXmlFragment(FRAGMENT_NAME);
  if (fragment.length === 0) {
    return { markdown: '', losses: [], empty: true };
  }

  const json: unknown = yXmlFragmentToProseMirrorRootNode(fragment, nixSchema).toJSON();
  const rendered = documentToMarkdown(json);
  return { markdown: rendered.markdown, losses: rendered.losses, empty: false };
}

/** Parses and bounds Markdown before any document is opened. */
export function prepareMarkdown(markdown: string, mode: MarkdownWriteMode): MarkdownPrepared {
  if (markdown.length > MARKDOWN_CHAR_LIMIT) {
    return {
      ok: false,
      tooLong: true,
      reason: `Markdown may be at most ${String(MARKDOWN_CHAR_LIMIT)} characters.`,
    };
  }

  if (mode === 'append' && markdown.trim().length === 0) {
    return { ok: false, reason: 'Append Markdown that is not empty.' };
  }

  const parsed = markdownToDocument(markdown);
  if (!parsed.ok) {
    // An empty replace is a cleared note: the editor's empty document, one paragraph, which
    // is what a brand-new note already is. The parser refuses a document with no blocks.
    if (mode === 'replace' && markdown.trim().length === 0) {
      return { ok: true, doc: emptyDocument(), scan: EMPTY_MARKDOWN_IMPORT_SCAN };
    }
    return { ok: false, reason: parsed.reason };
  }

  return { ok: true, doc: parsed.doc, scan: parsed.scan };
}

export type MarkdownPrepared =
  | { readonly ok: true; readonly doc: unknown; readonly scan: MarkdownImportScan }
  | { readonly ok: false; readonly reason: string; readonly tooLong?: boolean };

/**
 * Applies Markdown already accepted by {@link prepareMarkdown}.
 *
 * On failure the document is left as it was: a transaction that throws rolls back.
 */
export function applyPreparedMarkdown(
  doc: Y.Doc,
  prepared: Extract<MarkdownPrepared, { ok: true }>,
  mode: MarkdownWriteMode,
): MarkdownDelta {
  return mode === 'append'
    ? applyAppend(doc, prepared.doc, prepared.scan)
    : applyReplace(doc, prepared.doc, prepared.scan);
}

/**
 * Parses `markdown` and applies it. Prefer {@link prepareMarkdown} plus
 * {@link applyPreparedMarkdown} when the parse must happen before the document is opened.
 */
export function markdownDelta(
  doc: Y.Doc,
  markdown: string,
  mode: MarkdownWriteMode,
): MarkdownDelta {
  const prepared = prepareMarkdown(markdown, mode);
  if (!prepared.ok) {
    return prepared;
  }
  return applyPreparedMarkdown(doc, prepared, mode);
}

function emptyDocument(): unknown {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

function applyReplace(doc: Y.Doc, prose: unknown, scan: MarkdownImportScan): MarkdownDelta {
  let node;
  try {
    node = nixSchema.nodeFromJSON(prose);
  } catch (cause) {
    return {
      ok: false,
      reason:
        cause instanceof Error ? cause.message : 'The Markdown does not make a valid note body.',
    };
  }

  const before = Y.encodeStateVector(doc);
  const meta = { mapping: new Map(), isOMark: new Map() };
  doc.transact(() => {
    updateYFragment(doc, doc.getXmlFragment(FRAGMENT_NAME), node, meta);
  });
  return { ok: true, update: Y.encodeStateAsUpdate(doc, before), scan };
}

function applyAppend(doc: Y.Doc, prose: unknown, scan: MarkdownImportScan): MarkdownDelta {
  const scratch = new Y.Doc();
  try {
    const incoming = prosemirrorJSONToYXmlFragment(
      nixSchema,
      prose,
      scratch.getXmlFragment(FRAGMENT_NAME),
    );
    const blocks = incoming.toArray().map((node) => {
      if (!(node instanceof Y.XmlElement) && !(node instanceof Y.XmlText)) {
        throw new Error('Unsupported note block.');
      }
      return node.clone();
    });
    const fragment = doc.getXmlFragment(FRAGMENT_NAME);
    const before = Y.encodeStateVector(doc);
    doc.transact(() => {
      fragment.insert(fragment.length, blocks);
    });
    return { ok: true, update: Y.encodeStateAsUpdate(doc, before), scan };
  } catch (cause) {
    return {
      ok: false,
      reason:
        cause instanceof Error ? cause.message : 'The Markdown does not make a valid note body.',
    };
  } finally {
    scratch.destroy();
  }
}
