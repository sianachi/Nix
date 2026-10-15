import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { NixApiError } from '@nix/api-client';
import * as Y from 'yjs';
import { z } from 'zod';

import type { FetchImpl } from './session.ts';

const ELEMENTS = 'elements';
const MAX_ELEMENTS = 10_000;
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const MAX_UPDATE_BYTES = 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function base64Schema(maxBytes: number) {
  return z
    .string()
    .min(1)
    .max(Math.ceil(maxBytes / 3) * 4)
    .regex(BASE64);
}

const elementSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    versionNonce: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    isDeleted: z.boolean().optional(),
    index: z.string().optional(),
  })
  .loose();

export type CanvasElement = z.infer<typeof elementSchema>;

const sequenceSchema = z
  .union([
    z.string().regex(/^\d{1,20}$/),
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ])
  .transform(String);
const updateSchema = z.object({ seq: sequenceSchema, update: base64Schema(MAX_UPDATE_BYTES) });
const checkpointSchema = z.object({
  seq: sequenceSchema,
  update: base64Schema(MAX_SNAPSHOT_BYTES),
});
const pageSchema = z.object({
  docId: z.string().uuid(),
  headSeq: sequenceSchema,
  schemaVersion: z.number().int().nonnegative(),
  updates: z.array(updateSchema),
  hasMore: z.boolean(),
  checkpoint: checkpointSchema.optional(),
});

interface CanvasRequest {
  readonly collabUrl: string;
  readonly itemId: string;
  readonly token: string;
  readonly fetchImpl?: FetchImpl;
}

export interface CanvasRead {
  readonly elements: readonly CanvasElement[];
  readonly schemaVersion: number;
  readonly headSeq: string;
  readonly empty: boolean;
}

/** Accepts Excalidraw scene files and the keyed scene Nix stores durably. */
export function parseCanvasElements(value: unknown): CanvasElement[] {
  const scene =
    typeof value === 'object' && value !== null && 'elements' in value ? value.elements : value;
  const keyed = typeof scene === 'object' && scene !== null && !Array.isArray(scene) ? scene : null;
  const elements = z
    .array(elementSchema)
    .max(MAX_ELEMENTS)
    .parse(keyed === null ? scene : Object.values(keyed));
  const ids = new Set<string>();
  for (const element of elements) {
    if (ids.has(element.id)) throw new Error(`Canvas element '${element.id}' occurs twice.`);
    if (keyed !== null && !isDeepStrictEqual(Reflect.get(keyed, element.id), element)) {
      throw new Error(`Canvas element '${element.id}' does not match its scene key.`);
    }
    ids.add(element.id);
  }
  if (Buffer.byteLength(JSON.stringify(keyed ?? elements)) > MAX_DOCUMENT_BYTES) {
    throw new Error('The canvas scene exceeds 8 MiB.');
  }
  return elements;
}

export async function readCanvasBody(input: CanvasRequest): Promise<CanvasRead> {
  const doc = new Y.Doc();
  try {
    const state = await catchUp(doc, input);
    const elements = parseCanvasElements(doc.getMap(ELEMENTS).toJSON());
    elements.sort((left, right) => {
      const a = left.index ?? '';
      const b = right.index ?? '';
      return a === b ? (left.id < right.id ? -1 : 1) : a < b ? -1 : 1;
    });
    return { elements, ...state };
  } finally {
    doc.destroy();
  }
}

export interface CanvasWrite {
  readonly seq: string;
  readonly bytes: number;
  readonly changed: number;
}

/** Merge complete elements; omissions retain shapes and deletions use tombstones. */
export async function writeCanvasBody(
  input: CanvasRequest & { readonly elements: readonly CanvasElement[] },
): Promise<CanvasWrite> {
  const candidates = parseCanvasElements(input.elements);
  const doc = new Y.Doc();
  try {
    const state = await catchUp(doc, input);
    const map = doc.getMap<CanvasElement>(ELEMENTS);
    parseCanvasElements(map.toJSON());
    const changed = candidates.filter((element) => {
      const existing = map.get(element.id);
      if (existing === undefined) return true;
      if (isDeepStrictEqual(element, existing)) return false;
      if (
        element.version < existing.version ||
        (element.version === existing.version && element.versionNonce >= existing.versionNonce)
      ) {
        throw new Error(
          `Canvas element '${element.id}' is stale. Read the scene and increase its version before editing.`,
        );
      }
      return true;
    });
    if (changed.length === 0) return { seq: state.headSeq, bytes: 0, changed: 0 };

    const before = Y.encodeStateVector(doc);
    doc.transact(() => {
      for (const element of changed) map.set(element.id, structuredClone(element));
    });
    parseCanvasElements(map.toJSON());
    const delta = Y.encodeStateAsUpdate(doc, before);
    if (delta.byteLength > MAX_UPDATE_BYTES) {
      throw new Error('The canvas update exceeds 1 MiB. Write fewer elements at a time.');
    }
    const response = await (input.fetchImpl ?? globalThis.fetch)(
      `${input.collabUrl}/documents/${input.itemId}/updates`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${input.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          update: Buffer.from(delta).toString('base64'),
          clientId: `nixctl-${randomUUID()}`,
          expectedDocId: state.docId,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!response.ok) throw await canvasError(response);
    const body = z.object({ seq: z.string() }).parse(await response.json());
    return { seq: body.seq, bytes: delta.byteLength, changed: changed.length };
  } finally {
    doc.destroy();
  }
}

async function catchUp(
  doc: Y.Doc,
  input: CanvasRequest,
): Promise<Omit<CanvasRead, 'elements'> & { docId: string }> {
  let after = 0n;
  let schemaVersion = 0;
  let headSeq = '0';
  let empty = true;
  let docId: string | undefined;
  let replayedBytes = 0;
  for (;;) {
    const response = await (input.fetchImpl ?? globalThis.fetch)(
      `${input.collabUrl}/documents/${input.itemId}/updates?after=${String(after)}`,
      {
        headers: { authorization: `Bearer ${input.token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!response.ok) throw await canvasError(response);
    const page = pageSchema.parse(await response.json());
    if (docId !== undefined && docId !== page.docId) {
      throw new Error(
        'The canvas body changed during this read. Retry against its current document.',
      );
    }
    docId = page.docId;
    schemaVersion = page.schemaVersion;
    headSeq = page.headSeq;
    if (after === 0n && page.checkpoint !== undefined) {
      replayedBytes = applyUpdate(doc, page.checkpoint.update, replayedBytes, MAX_SNAPSHOT_BYTES);
      after = BigInt(page.checkpoint.seq);
      empty = after === 0n;
    }
    const previous = after;
    for (const entry of page.updates) {
      const seq = BigInt(entry.seq);
      if (seq <= after) continue;
      if (seq !== after + 1n)
        throw new Error('The canvas needs a retained checkpoint to continue. Retry this read.');
      replayedBytes = applyUpdate(doc, entry.update, replayedBytes, MAX_UPDATE_BYTES);
      after = seq;
      empty = false;
    }
    if (!page.hasMore || page.updates.length === 0) {
      if (after < BigInt(page.headSeq))
        throw new Error('The canvas needs a retained checkpoint to continue. Retry this read.');
      return { docId, schemaVersion, headSeq, empty };
    }
    if (after === previous && page.checkpoint === undefined) {
      throw new Error('Canvas history stopped before its last page.');
    }
  }
}

function applyUpdate(
  doc: Y.Doc,
  encoded: string,
  replayedBytes: number,
  maxUpdateBytes: number,
): number {
  const update = new Uint8Array(Buffer.from(encoded, 'base64'));
  if (update.byteLength > maxUpdateBytes) {
    throw new Error(
      `A canvas update exceeds the ${String(maxUpdateBytes)} byte collaboration limit.`,
    );
  }
  if (replayedBytes + update.byteLength > MAX_SNAPSHOT_BYTES) {
    throw new Error(
      'The canvas replay exceeds the 16 MiB collaboration snapshot limit. Retry after compaction.',
    );
  }
  Y.applyUpdate(doc, update);
  return replayedBytes + update.byteLength;
}

async function canvasError(response: Response): Promise<Error> {
  try {
    const body = z
      .object({
        code: z.string().optional(),
        title: z.string().optional(),
        detail: z.string().optional(),
      })
      .parse(await response.json());
    if (body.code !== undefined) {
      return NixApiError.fromProblemDetails(response.status, {
        code: body.code,
        title: body.title,
        detail: body.detail,
      });
    }
    return NixApiError.fromStatus(response.status, body.detail);
  } catch {
    return NixApiError.fromStatus(
      response.status,
      `The canvas body request was refused (${String(response.status)}).`,
    );
  }
}
