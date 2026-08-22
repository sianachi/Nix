/**
 * A note's body, read and written as Markdown.
 *
 * **The body is not in Core's REST API - it lives in the collaboration service as a Yjs update
 * log** - so this is the one place the CLI speaks that service's protocol. Reading catches up the
 * log into a `Y.Doc`, materialises the `default` prose fragment to ProseMirror JSON, and renders it
 * with `@nix/markdown`. Writing does the reverse and then some: it catches up to the current state,
 * applies the new document to the fragment as a *minimal* change (the same `updateYFragment` the web
 * editor's binding uses, so a one-word edit is a one-word update rather than a whole-document
 * replacement), and posts the delta. Yjs merges it against whatever else has happened since, which
 * is what makes a write from a script safe next to a person editing the same note.
 *
 * The heavy machinery - `yjs`, `y-prosemirror`, the schema, the Markdown mapping - is imported here
 * and nowhere else, and the note command dynamic-imports this module, so a `nixctl item ls` never
 * pays to load a CRDT runtime it does not use.
 */

import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import { nixSchema } from '@nix/editor-schema';
import {
  documentToMarkdown,
  markdownToDocument,
  type MarkdownImportScan,
  type MarkdownLoss,
} from '@nix/markdown';
import type { FetchImpl } from './session.ts';

/** The Yjs fragment a note's prose binds to; must match the collaboration service's own. */
const FRAGMENT = 'default';

/**
 * How long one collab request may take before it is abandoned. Without this, a single stalled
 * request hangs the command silently - and a caller running the write in a loop (`import`) would
 * stall mid-tree with no output and no stop reason rather than reporting one failed entry.
 */
const COLLAB_TIMEOUT_MS = 30_000;

/** Collab returns at most this many updates a page; the reader pages until it has them all. */
interface UpdatesPage {
  readonly docId: string;
  readonly headSeq: number;
  readonly schemaVersion: number;
  readonly updates: readonly { readonly seq: number; readonly update: string }[];
  readonly hasMore: boolean;
}

export interface BodyRead {
  readonly markdown: string;
  readonly schemaVersion: number;
  readonly losses: readonly MarkdownLoss[];

  /** True when the item has no body log yet - a note nobody has opened, not an error. */
  readonly empty: boolean;
}

/**
 * Catches up an item's body log into a document and renders it as Markdown.
 *
 * @throws When the body is not visible, or a page cannot be reached.
 */
export async function readBodyMarkdown(input: {
  readonly collabUrl: string;
  readonly itemId: string;
  readonly token: string;
  readonly fetchImpl?: FetchImpl;
}): Promise<BodyRead> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const doc = new Y.Doc();
  let after = 0;
  let schemaVersion = 0;
  let sawAny = false;

  for (;;) {
    const page = await fetchUpdates(fetchImpl, input.collabUrl, input.itemId, input.token, after);
    schemaVersion = page.schemaVersion;
    for (const entry of page.updates) {
      Y.applyUpdate(doc, base64ToBytes(entry.update));
      after = entry.seq;
      sawAny = true;
    }
    if (!page.hasMore || page.updates.length === 0) {
      break;
    }
  }

  const json: unknown = yXmlFragmentToProseMirrorRootNode(
    doc.getXmlFragment(FRAGMENT),
    nixSchema,
  ).toJSON();
  const { markdown, losses } = documentToMarkdown(json);
  return { markdown, schemaVersion, losses, empty: !sawAny };
}

export interface BodyWrite {
  readonly seq: string;
  readonly bytes: number;
  readonly scan: MarkdownImportScan;
}

/**
 * Replaces an item's body with the given Markdown, as a minimal Yjs delta over its current state.
 *
 * @throws When the Markdown does not parse into a valid body, or the write is refused.
 */
export async function writeBodyMarkdown(input: {
  readonly collabUrl: string;
  readonly itemId: string;
  readonly token: string;
  readonly markdown: string;
  /** The already-parsed document and its inseparable scan, when the caller validated it. */
  readonly parsed?: { readonly doc: unknown; readonly scan: MarkdownImportScan };
  /**
   * Skip the catch-up read because the caller knows the update log is empty - an item it created
   * moments ago. Against an empty base the full state is the delta, so nothing changes in what is
   * posted; what is saved is one round trip per write, which for an import is a quarter to a third
   * of its whole traffic. Never set this for an item that may have been edited: the merge-safety
   * of the write comes from that catch-up.
   */
  readonly assumeEmpty?: boolean;
  readonly fetchImpl?: FetchImpl;
}): Promise<BodyWrite> {
  let parsed: { readonly doc: unknown; readonly scan: MarkdownImportScan };
  if (input.parsed !== undefined) {
    parsed = input.parsed;
  } else {
    const converted = markdownToDocument(input.markdown);
    if (!converted.ok) {
      throw new Error(`The Markdown does not make a valid note body: ${converted.reason}`);
    }
    parsed = converted;
  }

  const fetchImpl = input.fetchImpl ?? globalThis.fetch;

  // Catch up first, so the delta is computed against the note as it stands and Yjs can merge it
  // with whatever else has happened rather than clobbering it.
  const doc = new Y.Doc();
  if (input.assumeEmpty !== true) {
    let after = 0;
    for (;;) {
      const page = await fetchUpdates(fetchImpl, input.collabUrl, input.itemId, input.token, after);
      for (const entry of page.updates) {
        Y.applyUpdate(doc, base64ToBytes(entry.update));
        after = entry.seq;
      }
      if (!page.hasMore || page.updates.length === 0) {
        break;
      }
    }
  }

  const before = Y.encodeStateVector(doc);
  const node = nixSchema.nodeFromJSON(parsed.doc);
  // A fresh binding metadata: empty maps mean updateYFragment diffs the whole fragment against the
  // new node from scratch, which is what we want for a body being replaced from outside the editor.
  const meta = { mapping: new Map(), isOMark: new Map() };
  doc.transact(() => {
    updateYFragment(doc, doc.getXmlFragment(FRAGMENT), node, meta);
  });

  const delta = Y.encodeStateAsUpdate(doc, before);
  const response = await fetchImpl(`${input.collabUrl}/documents/${input.itemId}/updates`, {
    method: 'POST',
    headers: { authorization: `Bearer ${input.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ update: bytesToBase64(delta), clientId: `nixctl-${randomUUID()}` }),
    signal: AbortSignal.timeout(COLLAB_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw await collabError(response);
  }

  const body = (await response.json()) as { seq?: unknown };
  return {
    seq: typeof body.seq === 'string' ? body.seq : '',
    bytes: delta.byteLength,
    scan: parsed.scan,
  };
}

async function fetchUpdates(
  fetchImpl: FetchImpl,
  collabUrl: string,
  itemId: string,
  token: string,
  after: number,
): Promise<UpdatesPage> {
  const response = await fetchImpl(
    `${collabUrl}/documents/${itemId}/updates?after=${String(after)}`,
    {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(COLLAB_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw await collabError(response);
  }
  return (await response.json()) as UpdatesPage;
}

function base64ToBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

async function collabError(response: Response): Promise<Error> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === 'string' && body.detail.length > 0) {
      return new Error(body.detail);
    }
  } catch {
    // Falls through.
  }
  return new Error(
    response.status === 404
      ? 'That note body is not available to you.'
      : `The note body request was refused (${String(response.status)}).`,
  );
}
