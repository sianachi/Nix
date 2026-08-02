import {
  BASE_SCHEMA_VERSION,
  countNodes,
  nixSchema,
  requiredSchemaVersion,
} from '@nix/editor-schema';
import {
  SHEET_ITEM_TYPE,
  SHEET_LIMITS,
  checkSheetDocument,
  readCells,
  sheetSnapshot,
} from '@nix/sheet';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import type * as Y from 'yjs';

import { LIMITS } from './limits.ts';

/** What one measurement of a merged document says about it. */
export interface Measurement {
  readonly nodes: number;
  readonly bytes: number;

  /**
   * The lowest schema version a build must speak to open this document, which is never
   * above `SCHEMA_VERSION` for a document this build produced and may be below it for one
   * using nothing new.
   */
  readonly schemaVersion: number;
}

/**
 * How one kind of body is validated and materialised.
 *
 * `item.type` says how an item's own body is drawn - a note's prose, a canvas's scene -
 * and this is where that fact touches the collaboration service. Everything else here
 * (the log, the transport, auth, tenancy, rate limits) is body-agnostic on purpose; the
 * only operations that must know what the bytes mean are "is the merged document one this
 * build could open again" and "what goes in the snapshot for search and previews". Those
 * two are what a strategy carries.
 */
export interface BodyKindStrategy {
  readonly kind: string;

  /** The ceilings a merged document must fit inside, in this kind's own unit of "node". */
  readonly ceilings: { readonly nodes: number; readonly bytes: number };

  /**
   * Measures a state as this kind of document: element count, serialised size, and the
   * lowest schema version a build must speak to open it - or null when the state does not
   * parse as this kind at all.
   *
   * `schemaVersion` is part of the measurement rather than a second method because both
   * facts are wanted at the same moment, on every accepted update, by the same caller - not
   * because one walk answers both: `noteStrategy` walks the document twice, once for
   * `countNodes` and once for `requiredSchemaVersion`. Fusing them saves about 0.2ms on an
   * 18,000-node document and is not worth the API change while `JSON.stringify` below is
   * two thirds of this method's cost. A kind whose content is not versioned by
   * `SCHEMA_VERSION` reports the base version, which is the honest answer: nothing in it can
   * require a newer build.
   */
  measure(state: Y.Doc): Measurement | null;

  /**
   * What the snapshot stores beside the Yjs state, so search and previews can read the
   * document without a Yjs runtime. The JSON lands in the snapshot's materialised-body
   * column; the plaintext feeds search.
   */
  materialize(state: Y.Doc): { json: unknown; plaintext: string };
}

/**
 * The Yjs fragment the prose editor binds to. One name, agreed by both sides; a mismatch
 * would produce two documents that merge cleanly and share no text.
 */
export const FRAGMENT_NAME = 'default';

/** The Yjs map a canvas scene lives in, keyed by element identifier. */
export const CANVAS_ELEMENTS = 'elements';

/** How many elements one canvas may hold. The browser renders every one of them. */
export const CANVAS_ELEMENT_CEILING = 10_000;

/**
 * Prose: the ProseMirror document in the shared XML fragment, validated by parsing.
 *
 * Two failures are folded together on purpose: a fragment holding a node this build has
 * never heard of throws while being read, and a fragment whose shape breaks the content
 * rules fails `check()`. Both mean the same thing - the merge would produce something
 * that cannot be opened - and neither is worth distinguishing in a refusal.
 */
export const noteStrategy: BodyKindStrategy = {
  kind: 'note',
  ceilings: { nodes: LIMITS.documentNodes, bytes: LIMITS.documentBytes },

  measure(state: Y.Doc): Measurement | null {
    const document = readProse(state);
    if (document === null) {
      return null;
    }
    return {
      nodes: countNodes(document),
      bytes: Buffer.byteLength(JSON.stringify(document.toJSON())),
      schemaVersion: requiredSchemaVersion(document),
    };
  },

  materialize(state: Y.Doc): { json: unknown; plaintext: string } {
    const document = readProse(state);
    return {
      json: document?.toJSON() ?? null,
      // No leaf-text argument: passing one overrides every node's own `leafText`, which is how
      // a reference contributes the title it points at. With one, a document whose only mention
      // of a topic is a link to it was unfindable by that topic.
      plaintext: document === null ? '' : document.textBetween(0, document.content.size, '\n'),
    };
  },
};

/**
 * Canvas: a scene of elements in a shared map, element-per-key, whole-element writes.
 *
 * The shape is the client's reconciliation contract - id, version and versionNonce are
 * what let two whole-element writes order deterministically - so the server refuses an
 * element missing them the same way it refuses prose the schema cannot open: the merge
 * would produce a document some client cannot reconcile.
 */
export const canvasStrategy: BodyKindStrategy = {
  kind: 'canvas',
  ceilings: { nodes: CANVAS_ELEMENT_CEILING, bytes: LIMITS.documentBytes },

  measure(state: Y.Doc): Measurement | null {
    const scene = readScene(state);
    if (scene === null) {
      return null;
    }
    return {
      nodes: Object.keys(scene).length,
      bytes: Buffer.byteLength(JSON.stringify(scene)),
      // A scene carries no ProseMirror nodes, so nothing in it can require a newer build.
      schemaVersion: BASE_SCHEMA_VERSION,
    };
  },

  materialize(state: Y.Doc): { json: unknown; plaintext: string } {
    const scene = readScene(state) ?? {};
    // The searchable text of a drawing is the words written on it: text elements and
    // labels. Geometry has nothing to say to a search index.
    const words: string[] = [];
    for (const element of Object.values(scene)) {
      const text = (element as { text?: unknown }).text;
      if (typeof text === 'string' && text.length > 0) {
        words.push(text);
      }
    }
    return { json: { elements: scene }, plaintext: words.join('\n') };
  },
};

/**
 * Sheet: a cell grid in a shared map, validated and evaluated by `@nix/sheet` - the same
 * engine the editor runs, so the value a client computed is the value the server checks.
 *
 * `measure` folds two failure modes into one null the way the other strategies do:
 * a structurally broken cell map, and cell content this build cannot finish evaluating
 * within its op budget. Both mean the merge would produce a document that cannot be
 * opened back up as a sheet - either literally, or because reopening it would spend the
 * same unbounded time computing it that got it refused here. The cell-count ceiling
 * itself is left to `judgeCandidate`'s shared over-ceiling handling (§17), matching
 * prose and canvas, rather than being enforced twice - `checkSheetDocument` is asked
 * with an unbounded cell count on purpose, so its own bound never doubles up with
 * `ceilings.nodes` below and produce a mismatched refusal for a document that grew.
 */
const SHEET_STRUCTURAL_LIMITS = { ...SHEET_LIMITS, maxCells: Number.MAX_SAFE_INTEGER };

export const sheetStrategy: BodyKindStrategy = {
  kind: SHEET_ITEM_TYPE,
  ceilings: { nodes: SHEET_LIMITS.maxCells, bytes: LIMITS.documentBytes },

  measure(state: Y.Doc): Measurement | null {
    if (checkSheetDocument(state, SHEET_STRUCTURAL_LIMITS) !== null) {
      return null;
    }
    const cells = readCells(state);
    return {
      nodes: cells.size,
      bytes: Buffer.byteLength(JSON.stringify(Object.fromEntries(cells))),
      // A cell grid carries no ProseMirror nodes; `@nix/sheet` versions its own content.
      schemaVersion: BASE_SCHEMA_VERSION,
    };
  },

  materialize(state: Y.Doc): { json: unknown; plaintext: string } {
    return sheetSnapshot(state);
  },
};

/**
 * Picks the strategy for a body kind, falling back to prose for kinds this build has
 * never heard of.
 *
 * The fallback is ADR-0009's rule holding at this seam: `item.type` is an open set and
 * must never gate behaviour it does not need to. An unknown kind behaves exactly as
 * every body behaved before kinds were dispatched at all - validated as prose - so
 * adding a kind is a feature, not a fork in what existing documents are allowed to do.
 */
export function strategyFor(bodyKind: string): BodyKindStrategy {
  if (bodyKind === canvasStrategy.kind) {
    return canvasStrategy;
  }
  if (bodyKind === sheetStrategy.kind) {
    return sheetStrategy;
  }
  return noteStrategy;
}

function readProse(state: Y.Doc): ProseMirrorNode | null {
  try {
    const document = yXmlFragmentToProseMirrorRootNode(
      state.getXmlFragment(FRAGMENT_NAME),
      nixSchema,
    );
    document.check();
    return document;
  } catch {
    return null;
  }
}

function readScene(state: Y.Doc): Record<string, unknown> | null {
  try {
    const scene = state.getMap(CANVAS_ELEMENTS).toJSON() as Record<string, unknown>;
    for (const [id, element] of Object.entries(scene)) {
      if (typeof element !== 'object' || element === null) {
        return null;
      }
      const candidate = element as {
        id?: unknown;
        type?: unknown;
        version?: unknown;
        versionNonce?: unknown;
      };
      if (
        candidate.id !== id ||
        typeof candidate.type !== 'string' ||
        typeof candidate.version !== 'number' ||
        typeof candidate.versionNonce !== 'number'
      ) {
        return null;
      }
    }
    return scene;
  } catch {
    return null;
  }
}
