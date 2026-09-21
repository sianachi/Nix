import { SCHEMA_VERSION } from '@nix/editor-schema';
import {
  ARCHIVE_FORMAT,
  FILE_ARCHIVE_FORMAT_VERSION,
  TEMPLATE_PROFILE_VERSION,
  type ArchiveFileBytes,
  type ArchiveFileVersionEntry,
  type TemplateInitialization as ArchiveTemplateInitialization,
  type ArchiveManifest,
  type ItemBody,
  type ItemBundle,
  type PropertyDefinition,
  type SchemaSnapshot,
} from '@nix/export';
import { SHEET_ITEM_TYPE, SHEET_SCHEMA_VERSION } from '@nix/sheet';
import type { Pool } from 'pg';

import { findDocByItem } from '../db/documents.ts';
import { streamInTenantScope } from '../db/tenant-scope.ts';
import { strategyFor } from '../documents/body-kinds.ts';
import { loadDocument } from '../documents/service.ts';
import { remapItemReferences, TemplateBodyError } from './bodies.ts';
import type {
  CoreTemplateClient,
  TemplateExportFile,
  TemplateExportItem,
  TemplateExportSnapshot,
} from './core.ts';

const FILE_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

type PortableTemplateExportItem = Omit<TemplateExportItem, 'schema'> & {
  readonly schema: SchemaSnapshot | null;
};

type PortableTemplateExportSnapshot = Omit<TemplateExportSnapshot, 'items'> & {
  readonly items: readonly PortableTemplateExportItem[];
};

export interface PreparedTemplateExport {
  readonly manifest: ArchiveManifest;
  readonly bundles: AsyncGenerator<ItemBundle>;
  readonly files: AsyncGenerator<ArchiveFileBytes, void, unknown>;
  readonly title: string;
}

export async function prepareTemplateArchive(options: {
  readonly core: CoreTemplateClient;
  readonly pool: Pool;
  readonly token: string;
  readonly templateId: string;
  readonly exportedAt: Date;
  readonly signal?: AbortSignal;
}): Promise<PreparedTemplateExport> {
  const snapshot = normalizeSchemas(
    await options.core.getTemplateExport(options.token, options.templateId),
  );
  const exportedFiles = await templateExportFiles(
    options.core,
    options.token,
    options.templateId,
    snapshot.revision,
  );
  const root = snapshot.items[0];
  if (root?.parentSourceId !== null) {
    throw new TemplateBodyError('template.export_invalid', 'The template has no root item.');
  }
  const authorization = await options.core.authorizeTemplateItem(
    options.token,
    options.templateId,
    root.sourceId,
  );
  if (!authorization.canRead) {
    throw new TemplateBodyError('template.not_found', 'No such template.');
  }

  const portableIds = new Map(snapshot.items.map((item) => [item.itemId, item.sourceId]));
  const exportedAt = options.exportedAt.toISOString();
  const files = [...exportedFiles].sort(
    (left, right) => left.sourceId.localeCompare(right.sourceId) || left.version - right.version,
  );
  const fileDescriptors: ArchiveFileVersionEntry[] = files.map((file) => ({
    itemId: file.sourceId,
    version: file.version,
    current: file.current,
    fileName: file.fileName,
    mediaType: file.mediaType,
    byteLength: file.byteLength,
    sha256: file.sha256,
    previewable: file.previewable,
    pixelWidth: file.pixelWidth,
    pixelHeight: file.pixelHeight,
  }));
  const manifest: ArchiveManifest = {
    format: ARCHIVE_FORMAT,
    formatVersion: FILE_ARCHIVE_FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    profile: {
      kind: 'template',
      version: TEMPLATE_PROFILE_VERSION,
      key: snapshot.stableKey,
      name: snapshot.title,
      description: snapshot.description ?? '',
      includeBody: snapshot.includeBody,
      includeChildren: snapshot.includeChildren,
      initialization: portableInitialization(snapshot.initialization),
    },
    exportedAt,
    root: root.sourceId,
    rootEffectiveSchema: root.schema,
    includesDeleted: false,
    items: snapshot.items.map((item) => ({
      id: item.sourceId,
      parentId: item.parentSourceId,
      seq: item.seq,
      title: item.title,
      type: item.itemType,
    })),
    files: fileDescriptors,
    omitted: [],
    loss: [],
  };

  return {
    manifest,
    title: snapshot.title,
    bundles: templateBundles(options.pool, authorization, snapshot, portableIds, exportedAt),
    files: templateFileBytes(
      options.core,
      options.token,
      options.templateId,
      snapshot.revision,
      files,
      options.signal,
    ),
  };
}

async function* templateFileBytes(
  core: CoreTemplateClient,
  token: string,
  templateId: string,
  revision: number,
  files: readonly TemplateExportFile[],
  signal?: AbortSignal,
): AsyncGenerator<ArchiveFileBytes, void, unknown> {
  for (const file of files) {
    const requestSignal =
      signal === undefined
        ? AbortSignal.timeout(FILE_DOWNLOAD_TIMEOUT_MS)
        : AbortSignal.any([signal, AbortSignal.timeout(FILE_DOWNLOAD_TIMEOUT_MS)]);
    const capability = await core.getTemplateExportFileCapability(
      token,
      templateId,
      file.fileVersionId,
      revision,
      requestSignal,
    );
    const response = await fetch(capability.downloadUrl, {
      signal: requestSignal,
      redirect: 'error',
    });
    if (!response.ok || response.body === null) {
      await response.body?.cancel().catch(() => undefined);
      throw new TemplateBodyError(
        'template.file_download_failed',
        `The bytes for template file ${file.sourceId} version ${String(file.version)} could not be read.`,
      );
    }
    yield {
      itemId: file.sourceId,
      version: file.version,
      chunks: responseChunks(response.body, requestSignal),
    };
  }
}

async function templateExportFiles(
  core: CoreTemplateClient,
  token: string,
  templateId: string,
  snapshotRevision: number,
): Promise<readonly TemplateExportFile[]> {
  const files: TemplateExportFile[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let revision: number | undefined;
  for (;;) {
    const page = await core.getTemplateExportFiles(token, templateId, cursor, revision);
    if (
      page.revision !== snapshotRevision ||
      (revision !== undefined && page.revision !== revision)
    ) {
      throw new TemplateBodyError(
        'template.export_changed',
        'The template changed during export; retry the export.',
      );
    }
    revision ??= page.revision;
    if (page.files.length > 100 || files.length + page.files.length > 20_000) {
      throw new TemplateBodyError(
        'template.export_invalid',
        'The template file history exceeds archive limits.',
      );
    }
    files.push(...page.files);
    if (page.complete) return files;
    const next = page.nextAfterFileVersionId;
    if (next === null || cursors.has(next)) {
      throw new TemplateBodyError(
        'template.export_invalid',
        'Core returned an invalid template file cursor.',
      );
    }
    cursors.add(next);
    cursor = next;
  }
}

async function* responseChunks(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  let complete = false;
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        complete = true;
        return;
      }
      yield next.value;
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function portableInitialization(
  initialization: TemplateExportSnapshot['initialization'],
): ArchiveTemplateInitialization {
  return {
    version: 1,
    inputs: initialization.inputs.map((input) => ({ ...input })),
    rules: initialization.rules.map((rule) => {
      const base = { sourceId: rule.sourceId, propertyKey: rule.propertyKey, kind: rule.kind };
      if (rule.kind === 'set') return { ...base, value: rule.value };
      if (rule.kind === 'input') return { ...base, inputKey: rule.inputKey };
      if (rule.kind === 'relativeDate') {
        return {
          ...base,
          inputKey: rule.inputKey,
          offsetDays: rule.offsetDays,
          timeOfDay: rule.timeOfDay,
          timeZone: rule.timeZone,
        };
      }
      return base;
    }),
    references: initialization.references.map((reference) =>
      reference.policy === 'replace'
        ? {
            sourceItemId: reference.sourceItemId,
            policy: reference.policy,
            inputKey: reference.inputKey,
          }
        : { sourceItemId: reference.sourceItemId, policy: reference.policy },
    ),
  };
}

async function* templateBundles(
  pool: Pool,
  authorization: { tenantId: string; principalId: string },
  snapshot: PortableTemplateExportSnapshot,
  portableIds: ReadonlyMap<string, string>,
  exportedAt: string,
): AsyncGenerator<ItemBundle> {
  yield* streamInTenantScope(pool, authorization, async function* (sql) {
    for (const item of snapshot.items) {
      let body: ItemBody | null = null;
      if (item.hasBody) {
        const doc = await findDocByItem(sql, authorization.tenantId, item.itemId);
        if (doc === null) {
          throw new TemplateBodyError(
            'template.source_body_missing',
            `The body for template source ${item.sourceId} is missing.`,
          );
        }
        const state = await loadDocument(sql, authorization.tenantId, doc);
        const materialized = strategyFor(item.itemType).materialize(state).json;
        body = archiveBody(
          item.itemType,
          doc.schema_version,
          remapItemReferences(materialized, portableIds, false),
        );
      }
      yield {
        id: item.sourceId,
        parentId: item.parentSourceId,
        workspaceId: snapshot.workspaceId,
        type: item.itemType,
        title: item.title,
        seq: item.seq,
        lifecycleState: 'active',
        createdAt: exportedAt,
        updatedAt: exportedAt,
        properties: item.properties,
        schema: item.schema,
        views: item.views,
        recurrence: item.recurrence,
        viewRows: [],
        viewRowsTruncated: false,
        body,
      };
    }
  });
}

function archiveBody(itemType: string, schemaVersion: number, value: unknown): ItemBody {
  if (itemType === 'canvas') return { schemaVersion, canvas: value };
  if (itemType === SHEET_ITEM_TYPE || itemType === 'sheet') {
    return { schemaVersion: SHEET_SCHEMA_VERSION, sheet: value };
  }
  return { schemaVersion, prosemirror: value };
}

/** Expands Core's stored declarations into the effective+declared shape archive v1 promises. */
function normalizeSchemas(snapshot: TemplateExportSnapshot): PortableTemplateExportSnapshot {
  const effectiveBySource = new Map<string, readonly PropertyDefinition[]>();
  const items: PortableTemplateExportItem[] = [];

  for (const item of snapshot.items) {
    const parent = item.parentSourceId === null ? [] : effectiveBySource.get(item.parentSourceId);
    if (item.parentSourceId !== null && parent === undefined) {
      throw new TemplateBodyError(
        'template.export_invalid',
        `Template source ${item.sourceId} appears before its parent.`,
      );
    }

    if (item.schema === null) {
      effectiveBySource.set(item.sourceId, parent ?? []);
      items.push({ ...item, schema: null });
      continue;
    }

    const declared = item.schema.declared ?? item.schema.properties;
    const effective =
      item.schema.declared === undefined
        ? item.schema.inherit
          ? mergeProperties(parent ?? [], declared)
          : declared
        : item.schema.properties;
    effectiveBySource.set(item.sourceId, effective);
    items.push({
      ...item,
      schema: { properties: effective, declared, inherit: item.schema.inherit },
    });
  }

  return { ...snapshot, items };
}

/** Core's property cascade: nearer definitions replace in place, then append new keys. */
function mergeProperties(
  farther: readonly PropertyDefinition[],
  nearer: readonly PropertyDefinition[],
): readonly PropertyDefinition[] {
  const nearerByKey = new Map(nearer.map((property) => [property.key, property]));
  const fartherKeys = new Set(farther.map((property) => property.key));
  const merged = farther.map((property) => nearerByKey.get(property.key) ?? property);
  for (const property of nearer) {
    if (!fartherKeys.has(property.key)) merged.push(property);
  }
  return merged;
}
