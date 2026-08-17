import { randomUUID } from 'node:crypto';

import { SCHEMA_VERSION, nixSchema } from '@nix/editor-schema';
import type { ItemBody } from '@nix/export';
import { SHEET_CELLS_KEY, SHEET_ITEM_TYPE, SHEET_META_KEY } from '@nix/sheet';
import type { Pool } from 'pg';
import { prosemirrorJSONToYDoc } from 'y-prosemirror';
import * as Y from 'yjs';

import type { ContentDocRow } from '../db/documents.ts';
import { withTenantScope, type ScopedQuery, type TenantScope } from '../db/tenant-scope.ts';
import { CANVAS_ELEMENTS, FRAGMENT_NAME, strategyFor } from '../documents/body-kinds.ts';
import { checkMergedDocument } from '../documents/service.ts';
import { LIMITS } from '../documents/limits.ts';
import { boundSearchText } from '../documents/links.ts';

export interface OperationItemAuthorization {
  readonly tenantId: string;
  readonly principalId: string;
  readonly workspaceId: string;
  readonly itemType: string;
  readonly canWrite: boolean;
}

export interface BodyCopy {
  readonly sourceItemId: string;
  readonly targetItemId: string;
  readonly itemType: string;
}

/** Applies the exact Collab materialization and durable-update ceilings used during commit. */
export function validateArchiveBodies(
  bundles: readonly Pick<
    { readonly id: string; readonly type: string; readonly body: ItemBody | null },
    'id' | 'type' | 'body'
  >[],
): void {
  for (const bundle of bundles) {
    if (bundle.body === null) continue;
    const state = documentFromArchiveBody(bundle.type, bundle.body);
    try {
      const strategy = strategyFor(bundle.type);
      const refusal = checkMergedDocument(state, { strategy, pin: SCHEMA_VERSION });
      if (refusal !== null) {
        throw new TemplateBodyError(`template.${refusal.code}`, refusal.detail);
      }
      if (Y.encodeStateAsUpdate(state).byteLength > LIMITS.updateBytes) {
        throw new TemplateBodyError(
          'template.body_update_too_large',
          `The body for ${bundle.id} expands beyond the collaboration update ceiling.`,
        );
      }
    } finally {
      state.destroy();
    }
  }
}

/** Copies staged bodies as fresh Yjs histories while preserving only portable item references. */
export async function copyBodies(
  pool: Pool,
  authorization: OperationItemAuthorization,
  copies: readonly BodyCopy[],
  itemMappings: ReadonlyMap<string, string>,
): Promise<readonly string[]> {
  assertStagedWrite(authorization);
  return await withTenantScope(pool, scopeOf(authorization), async (sql) => {
    const sourceStates = await loadSourceStates(
      sql,
      authorization.tenantId,
      copies.map((copy) => copy.sourceItemId),
    );
    const fresh: FreshState[] = [];
    try {
      for (const copy of copies) {
        const source = sourceStates.get(copy.sourceItemId);
        if (source === undefined) {
          throw new TemplateBodyError(
            'template.source_body_missing',
            `The source body for ${copy.sourceItemId} disappeared before it could be copied.`,
          );
        }
        const body = strategyFor(copy.itemType).materialize(source).json;
        fresh.push({
          targetItemId: copy.targetItemId,
          itemType: copy.itemType,
          state: fromMaterialized(copy.itemType, remapItemReferences(body, itemMappings, true)),
        });
      }
      await persistFreshStates(sql, authorization, fresh);
      return copies.map((copy) => copy.targetItemId);
    } finally {
      for (const state of sourceStates.values()) state.destroy();
      for (const entry of fresh) entry.state.destroy();
    }
  });
}

/** Writes archive bodies into new staged envelopes. Existing document histories are never merged. */
export async function writeArchiveBodies(
  pool: Pool,
  authorization: OperationItemAuthorization,
  writes: readonly { sourceId: string; targetItemId: string; itemType: string; body: ItemBody }[],
  itemMappings: ReadonlyMap<string, string>,
): Promise<readonly string[]> {
  assertStagedWrite(authorization);
  return await withTenantScope(pool, scopeOf(authorization), async (sql) => {
    const fresh = writes.map((write) => ({
      targetItemId: write.targetItemId,
      itemType: write.itemType,
      state: documentFromArchiveBody(write.itemType, remapBody(write.body, itemMappings)),
    }));
    try {
      await persistFreshStates(sql, authorization, fresh);
      return writes.map((write) => write.targetItemId);
    } finally {
      for (const entry of fresh) entry.state.destroy();
    }
  });
}

export class TemplateBodyError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = 'TemplateBodyError';
    this.code = code;
  }
}

interface FreshState {
  readonly targetItemId: string;
  readonly itemType: string;
  readonly state: Y.Doc;
}

interface PreparedFreshState extends FreshState {
  readonly docId: string;
  readonly update: Uint8Array;
  readonly materialized: { json: unknown; plaintext: string };
  readonly links: ReadonlyMap<string, number> | null;
}

async function persistFreshStates(
  sql: ScopedQuery,
  authorization: OperationItemAuthorization,
  inputs: readonly FreshState[],
): Promise<void> {
  if (inputs.length === 0) return;
  const targetIds = inputs.map((input) => input.targetItemId);
  const existing = await sql.query<{ item_id: string }>(
    `SELECT item_id
       FROM content_doc
      WHERE tenant_id = $1 AND item_id = ANY($2::uuid[])`,
    [authorization.tenantId, targetIds],
  );
  const existingIds = new Set(existing.rows.map((row) => row.item_id));
  const prepared: PreparedFreshState[] = [];
  for (const input of inputs) {
    // Operation target rows are fresh and hidden. An existing document means a prior idempotent
    // attempt already initialized it; never rewrite a body that may since have been activated.
    if (existingIds.has(input.targetItemId)) continue;
    const strategy = strategyFor(input.itemType);
    const refusal = checkMergedDocument(input.state, { strategy, pin: SCHEMA_VERSION });
    if (refusal !== null) {
      throw new TemplateBodyError(`template.${refusal.code}`, refusal.detail);
    }
    const update = Y.encodeStateAsUpdate(input.state);
    if (update.byteLength > LIMITS.updateBytes) {
      throw new TemplateBodyError(
        'template.body_update_too_large',
        'A template body expands beyond the collaboration update ceiling.',
      );
    }
    const materialized = strategy.materialize(input.state);
    prepared.push({
      ...input,
      docId: randomUUID(),
      update,
      materialized,
      links: strategy.extractLinks?.(materialized.json, input.targetItemId) ?? null,
    });
  }
  if (prepared.length === 0) return;

  const inserted = await insertDocuments(sql, authorization, prepared);
  const toWrite = prepared.filter((entry) => inserted.has(entry.targetItemId));
  if (toWrite.length === 0) return;
  await insertInitialUpdates(sql, authorization, toWrite);
  await insertInitialSnapshots(sql, authorization, toWrite);
  await insertInitialSearch(sql, authorization, toWrite);
  await insertInitialLinks(sql, authorization, toWrite);
}

interface SourceDocumentRow extends ContentDocRow {
  readonly snapshot_seq: string | null;
  readonly yjs_state: Buffer | null;
}

interface SourceUpdateRow extends Record<string, unknown> {
  readonly doc_id: string;
  readonly update_bytes: Buffer;
}

async function loadSourceStates(
  sql: ScopedQuery,
  tenantId: string,
  itemIds: readonly string[],
): Promise<ReadonlyMap<string, Y.Doc>> {
  if (itemIds.length === 0) return new Map();
  const documents = await sql.query<SourceDocumentRow>(
    `SELECT d.doc_id, d.item_id, d.workspace_id, d.schema_version, d.head_seq,
            snapshot.seq AS snapshot_seq, snapshot.yjs_state
       FROM content_doc d
       LEFT JOIN LATERAL (
         SELECT s.seq, s.yjs_state
           FROM content_snapshot s
          WHERE s.tenant_id = d.tenant_id
            AND s.doc_id = d.doc_id
            AND s.seq <= d.head_seq
          ORDER BY s.seq DESC
          LIMIT 1
       ) snapshot ON TRUE
      WHERE d.tenant_id = $1 AND d.item_id = ANY($2::uuid[])`,
    [tenantId, [...new Set(itemIds)]],
  );
  const byItem = new Map<string, Y.Doc>();
  const byDoc = new Map<string, Y.Doc>();
  for (const row of documents.rows) {
    const state = new Y.Doc();
    if (row.yjs_state !== null) Y.applyUpdate(state, new Uint8Array(row.yjs_state));
    byItem.set(row.item_id, state);
    byDoc.set(row.doc_id, state);
  }
  if (documents.rows.length === 0) return byItem;

  const updates = await sql.query<SourceUpdateRow>(
    `WITH wanted AS (
       SELECT *
         FROM unnest($2::uuid[], $3::bigint[], $4::bigint[])
              AS source(doc_id, after_seq, head_seq)
     )
     SELECT stored.doc_id, stored.update_bytes
       FROM content_update stored
       JOIN wanted ON wanted.doc_id = stored.doc_id
      WHERE stored.tenant_id = $1
        AND stored.seq > wanted.after_seq
        AND stored.seq <= wanted.head_seq
      ORDER BY stored.doc_id, stored.seq`,
    [
      tenantId,
      documents.rows.map((row) => row.doc_id),
      documents.rows.map((row) => row.snapshot_seq ?? '0'),
      documents.rows.map((row) => row.head_seq),
    ],
  );
  for (const row of updates.rows) {
    const state = byDoc.get(row.doc_id);
    if (state !== undefined) Y.applyUpdate(state, new Uint8Array(row.update_bytes));
  }
  return byItem;
}

async function insertDocuments(
  sql: ScopedQuery,
  authorization: OperationItemAuthorization,
  prepared: readonly PreparedFreshState[],
): Promise<ReadonlySet<string>> {
  const result = await sql.query<{ item_id: string }>(
    `INSERT INTO content_doc
         (doc_id, tenant_id, item_id, workspace_id, schema_version, head_seq, created_at)
     SELECT input.doc_id, $1, input.item_id, $2, $3, 1, now()
       FROM unnest($4::uuid[], $5::uuid[]) AS input(doc_id, item_id)
     ON CONFLICT (tenant_id, item_id) DO NOTHING
     RETURNING item_id`,
    [
      authorization.tenantId,
      authorization.workspaceId,
      SCHEMA_VERSION,
      prepared.map((entry) => entry.docId),
      prepared.map((entry) => entry.targetItemId),
    ],
  );
  return new Set(result.rows.map((row) => row.item_id));
}

async function insertInitialUpdates(
  sql: ScopedQuery,
  authorization: OperationItemAuthorization,
  prepared: readonly PreparedFreshState[],
): Promise<void> {
  const values: string[] = [];
  const parameters: unknown[] = [authorization.tenantId, authorization.principalId];
  for (const entry of prepared) {
    const doc = parameters.push(entry.docId);
    const update = parameters.push(Buffer.from(entry.update));
    values.push(`($${String(doc)}, 1, $1, $${String(update)}, $2, 'template-operation', now())`);
  }
  await sql.query(
    `INSERT INTO content_update
         (doc_id, seq, tenant_id, update_bytes, actor_id, client_id, created_at)
     VALUES ${values.join(', ')}`,
    parameters,
  );
}

async function insertInitialSnapshots(
  sql: ScopedQuery,
  authorization: OperationItemAuthorization,
  prepared: readonly PreparedFreshState[],
): Promise<void> {
  const values: string[] = [];
  const parameters: unknown[] = [authorization.tenantId];
  for (const entry of prepared) {
    const doc = parameters.push(entry.docId);
    const state = parameters.push(Buffer.from(entry.update));
    const json = parameters.push(JSON.stringify(entry.materialized.json));
    const plaintext = parameters.push(entry.materialized.plaintext);
    values.push(
      `($${String(doc)}, 1, $1, $${String(state)}, $${String(json)}::jsonb, ` +
        `$${String(plaintext)}, now())`,
    );
  }
  await sql.query(
    `INSERT INTO content_snapshot
         (doc_id, seq, tenant_id, yjs_state, prosemirror_json, plaintext, created_at)
     VALUES ${values.join(', ')}`,
    parameters,
  );
}

async function insertInitialSearch(
  sql: ScopedQuery,
  authorization: OperationItemAuthorization,
  prepared: readonly PreparedFreshState[],
): Promise<void> {
  const values: string[] = [];
  const parameters: unknown[] = [authorization.tenantId];
  for (const entry of prepared) {
    const item = parameters.push(entry.targetItemId);
    const plaintext = parameters.push(boundSearchText(entry.materialized.plaintext));
    values.push(`($1, $${String(item)}, 1, now(), to_tsvector('english', $${String(plaintext)}))`);
  }
  await sql.query(
    `INSERT INTO item_search (tenant_id, item_id, seq, updated_at, body_vector)
     VALUES ${values.join(', ')}`,
    parameters,
  );
}

async function insertInitialLinks(
  sql: ScopedQuery,
  authorization: OperationItemAuthorization,
  prepared: readonly PreparedFreshState[],
): Promise<void> {
  const sources: string[] = [];
  const targets: string[] = [];
  const occurrences: number[] = [];
  for (const entry of prepared) {
    if (entry.links === null) continue;
    for (const [target, count] of entry.links) {
      sources.push(entry.targetItemId);
      targets.push(target);
      occurrences.push(count);
    }
  }
  if (sources.length === 0) return;
  await sql.query(
    `INSERT INTO item_link (tenant_id, source_item_id, target_item_id, occurrences, seq)
     SELECT $1, edge.source_id, edge.target_id, edge.occurrences, 1
       FROM unnest($2::uuid[], $3::uuid[], $4::int[])
            AS edge(source_id, target_id, occurrences)
      WHERE EXISTS (
        SELECT 1 FROM item WHERE item.tenant_id = $1 AND item.id = edge.target_id
      )`,
    [authorization.tenantId, sources, targets, occurrences],
  );
}

export function documentFromArchiveBody(itemType: string, body: ItemBody): Y.Doc {
  if (itemType === 'canvas' && 'canvas' in body) {
    return fromMaterialized(itemType, body.canvas);
  }
  if (isSheetItemType(itemType) && 'sheet' in body) {
    return fromMaterialized(itemType, body.sheet);
  }
  if ('prosemirror' in body) {
    return prosemirrorJSONToYDoc(nixSchema, body.prosemirror, FRAGMENT_NAME);
  }
  throw new TemplateBodyError(
    'template.body_kind_mismatch',
    `The archived body does not match item type "${itemType}".`,
  );
}

function fromMaterialized(itemType: string, value: unknown): Y.Doc {
  if (itemType === 'canvas') {
    const elements = nestedRecord(value, 'elements');
    const state = new Y.Doc();
    const scene = state.getMap(CANVAS_ELEMENTS);
    for (const [id, element] of Object.entries(elements)) scene.set(id, element);
    return state;
  }
  if (isSheetItemType(itemType)) {
    const sheet = record(value);
    const cells = record(sheet.cells);
    const meta = record(sheet.meta);
    const state = new Y.Doc();
    const cellMap = state.getMap(SHEET_CELLS_KEY);
    for (const [key, raw] of Object.entries(cells)) {
      if (typeof raw === 'string') cellMap.set(key, { raw });
    }
    const metaMap = state.getMap(SHEET_META_KEY);
    if (typeof meta.rows === 'number') metaMap.set('rows', meta.rows);
    if (typeof meta.cols === 'number') metaMap.set('cols', meta.cols);
    if (isRecord(meta.colWidths)) metaMap.set('colWidths', { ...meta.colWidths });
    return state;
  }
  return prosemirrorJSONToYDoc(nixSchema, value, FRAGMENT_NAME);
}

function isSheetItemType(itemType: string): boolean {
  return itemType === SHEET_ITEM_TYPE || itemType === 'sheet';
}

function remapBody(body: ItemBody, mappings: ReadonlyMap<string, string>): ItemBody {
  if ('prosemirror' in body) {
    return { ...body, prosemirror: remapItemReferences(body.prosemirror, mappings, true) };
  }
  if ('canvas' in body) {
    return { ...body, canvas: remapItemReferences(body.canvas, mappings, true) };
  }
  return { ...body, sheet: remapItemReferences(body.sheet, mappings, true) };
}

/** Remaps declared Nix item references and leaves arbitrary UUID-valued user data untouched. */
export function remapItemReferences(
  value: unknown,
  mappings: ReadonlyMap<string, string>,
  stubUnknown = false,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => remapItemReferences(entry, mappings, stubUnknown));
  }
  if (!isRecord(value)) return value;

  const mapped: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    mapped[key] = remapItemReferences(child, mappings, stubUnknown);
  }
  if (value.type === 'reference' && isRecord(value.attrs) && value.attrs.kind === 'item') {
    const target = value.attrs.targetId;
    if (typeof target === 'string') {
      const replacement = mappings.get(target);
      mapped.attrs = {
        ...record(mapped.attrs),
        targetId: replacement ?? (stubUnknown ? null : target),
      };
    }
  }
  return mapped;
}

function scopeOf(authorization: OperationItemAuthorization): TenantScope {
  return { tenantId: authorization.tenantId, principalId: authorization.principalId };
}

function assertStagedWrite(authorization: OperationItemAuthorization): void {
  if (!authorization.canWrite) {
    throw new TemplateBodyError(
      'template.operation_read_only',
      'Core did not authorize this staged template body write.',
    );
  }
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> {
  const outer = record(value);
  return record(outer[key]);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
