import { SCHEMA_VERSION } from '@nix/editor-schema';
import {
  ARCHIVE_FORMAT,
  ARCHIVE_FORMAT_VERSION,
  TEMPLATE_PROFILE_VERSION,
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
import type { CoreTemplateClient, TemplateExportItem, TemplateExportSnapshot } from './core.ts';

type PortableTemplateExportItem = Omit<TemplateExportItem, 'schema'> & {
  readonly schema: SchemaSnapshot | null;
};

type PortableTemplateExportSnapshot = Omit<TemplateExportSnapshot, 'items'> & {
  readonly items: readonly PortableTemplateExportItem[];
};

export interface PreparedTemplateExport {
  readonly manifest: ArchiveManifest;
  readonly bundles: AsyncGenerator<ItemBundle>;
  readonly title: string;
}

export async function prepareTemplateArchive(options: {
  readonly core: CoreTemplateClient;
  readonly pool: Pool;
  readonly token: string;
  readonly templateId: string;
  readonly exportedAt: Date;
}): Promise<PreparedTemplateExport> {
  const snapshot = normalizeSchemas(
    await options.core.getTemplateExport(options.token, options.templateId),
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
  const manifest: ArchiveManifest = {
    format: ARCHIVE_FORMAT,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    profile: {
      kind: 'template',
      version: TEMPLATE_PROFILE_VERSION,
      key: snapshot.stableKey,
      name: snapshot.title,
      description: snapshot.description ?? '',
      includeBody: snapshot.includeBody,
      includeChildren: snapshot.includeChildren,
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
    omitted: [],
    loss: [],
  };

  return {
    manifest,
    title: snapshot.title,
    bundles: templateBundles(options.pool, authorization, snapshot, portableIds, exportedAt),
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
          remapItemReferences(materialized, portableIds, true),
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
