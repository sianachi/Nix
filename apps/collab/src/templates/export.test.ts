import { readArchive, validateTemplateArchive, writeArchive } from '@nix/export';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import type { CoreTemplateClient } from './core.ts';
import { prepareTemplateArchive } from './export.ts';

const TEMPLATE = '11111111-1111-4111-8111-111111111111';
const SOURCE = '22222222-2222-4222-8222-222222222222';
const HIDDEN = '33333333-3333-4333-8333-333333333333';
const WORKSPACE = '44444444-4444-4444-8444-444444444444';
const STATUS = {
  key: 'status',
  label: 'Status',
  type: 'select',
  options: ['Open', 'Done'],
  required: false,
} as const;

describe('template archive preparation', () => {
  it('uses portable source ids and the additive template profile in the manifest', async () => {
    const core = exportCore();
    const prepared = await prepareTemplateArchive({
      core,
      pool: emptyPool(),
      token: 'token',
      templateId: TEMPLATE,
      exportedAt: new Date('2026-08-16T12:00:00Z'),
    });

    expect(prepared.manifest).toMatchObject({
      root: SOURCE,
      profile: {
        kind: 'template',
        version: 1,
        key: 'team.project',
        name: 'Team project',
        includeBody: false,
        includeChildren: false,
      },
      items: [{ id: SOURCE, parentId: null, title: 'Project' }],
      rootEffectiveSchema: {
        properties: [STATUS],
        declared: [STATUS],
        inherit: false,
      },
      omitted: [],
      loss: [],
    });
    expect(JSON.stringify(prepared.manifest)).not.toContain(HIDDEN);

    const chunks: Uint8Array[] = [];
    for await (const chunk of writeArchive(prepared)) chunks.push(chunk);
    // eslint-disable-next-line @typescript-eslint/require-await -- the reader deliberately accepts a streaming source.
    async function* upload(): AsyncGenerator<Uint8Array> {
      yield* chunks;
    }
    const reread = await readArchive(upload());
    validateTemplateArchive(reread);
    expect(reread.bundles[0]?.schema).toEqual({
      properties: [STATUS],
      declared: [STATUS],
      inherit: false,
    });
    expect(reread.bundles[0]?.views).toMatchObject({
      default: 'document',
      views: [{ id: 'list', columns: [], groupOrder: [], filters: [] }],
    });
  });
});

function exportCore(): CoreTemplateClient {
  const unused = () =>
    Promise.reject(new Error('This operation is not part of archive preparation.'));
  return {
    beginCapture: unused,
    beginImport: unused,
    beginApplication: unused,
    authorizeOperationItem: unused,
    finalize: unused,
    abort: unused,
    finalizeManaged: unused,
    sweepExpired: unused,
    authorizeImport: unused,
    beginDraft: unused,
    getDraft: unused,
    patchDraft: unused,
    patchDraftItem: unused,
    saveDraft: unused,
    discardDraft: unused,
    authorizeDraftItem: unused,
    authorizeTemplateItem: () =>
      Promise.resolve({
        templateId: TEMPLATE,
        sourceId: SOURCE,
        itemId: HIDDEN,
        tenantId: '55555555-5555-4555-8555-555555555555',
        principalId: '66666666-6666-4666-8666-666666666666',
        workspaceId: WORKSPACE,
        itemType: 'note',
        canRead: true,
        canWrite: true,
      }),
    getTemplateExport: () =>
      Promise.resolve({
        templateId: TEMPLATE,
        workspaceId: WORKSPACE,
        stableKey: 'team.project',
        title: 'Team project',
        description: 'A starting point.',
        origin: 'user',
        revision: 1,
        includeBody: false,
        includeChildren: false,
        items: [
          {
            sourceId: SOURCE,
            parentSourceId: null,
            itemId: HIDDEN,
            itemType: 'note',
            title: 'Project',
            seq: '1',
            properties: {},
            // Core's internal route returns the stored declaration, not an archive SchemaSnapshot.
            schema: { properties: [STATUS], inherit: false },
            views: {
              default: 'document',
              views: [
                {
                  id: 'list',
                  name: 'List',
                  kind: 'list',
                  columns: [],
                  groupBy: null,
                  groupOrder: [],
                  dateProperty: null,
                  sortBy: null,
                  sortDescending: false,
                  mode: null,
                  coverProperty: null,
                  endDateProperty: null,
                  cardSize: null,
                  filters: [],
                  companionViewId: null,
                  companionPlacement: null,
                  interactiveForm: null,
                },
              ],
            },
            hasBody: false,
          },
        ],
      }),
  };
}

function emptyPool(): Pool {
  const client = {
    query: () => Promise.resolve({ rows: [], rowCount: 0 }),
    release: () => undefined,
  };
  return { connect: () => Promise.resolve(client) } as unknown as Pool;
}
