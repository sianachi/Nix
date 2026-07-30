import { countNodes, nixSchema } from '@nix/editor-schema';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import type * as Y from 'yjs';

import { LIMITS } from './limits.ts';

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
   * Measures a state as this kind of document: element count and serialised size, or
   * null when the state does not parse as this kind at all.
   */
  measure(state: Y.Doc): { nodes: number; bytes: number } | null;

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

  measure(state: Y.Doc): { nodes: number; bytes: number } | null {
    const document = readProse(state);
    if (document === null) {
      return null;
    }
    return {
      nodes: countNodes(document),
      bytes: Buffer.byteLength(JSON.stringify(document.toJSON())),
    };
  },

  materialize(state: Y.Doc): { json: unknown; plaintext: string } {
    const document = readProse(state);
    return {
      json: document?.toJSON() ?? null,
      plaintext:
        document === null ? '' : document.textBetween(0, document.content.size, '\n', ' '),
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

  measure(state: Y.Doc): { nodes: number; bytes: number } | null {
    const scene = readScene(state);
    if (scene === null) {
      return null;
    }
    return {
      nodes: Object.keys(scene).length,
      bytes: Buffer.byteLength(JSON.stringify(scene)),
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
 * Picks the strategy for a body kind, falling back to prose for kinds this build has
 * never heard of.
 *
 * The fallback is ADR-0009's rule holding at this seam: `item.type` is an open set and
 * must never gate behaviour it does not need to. An unknown kind behaves exactly as
 * every body behaved before kinds were dispatched at all - validated as prose - so
 * adding a kind is a feature, not a fork in what existing documents are allowed to do.
 */
export function strategyFor(bodyKind: string): BodyKindStrategy {
  return bodyKind === canvasStrategy.kind ? canvasStrategy : noteStrategy;
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
