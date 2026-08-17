import type { ArchiveManifest, ItemBundle, TemplateArchiveProfile } from '@nix/export';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import type {
  ApplicationBegin,
  CaptureBegin,
  CoreTemplateClient,
  ImportBegin,
  OperationKind,
  TemplateDraft,
} from './core.ts';
import { CoreTemplateError } from './core.ts';
import { createTemplateService } from './service.ts';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOT = '22222222-2222-4222-8222-222222222222';
const TEMPLATE = '33333333-3333-4333-8333-333333333333';
const OPERATION = '44444444-4444-4444-8444-444444444444';

interface Calls {
  beginBody?: unknown;
  finalized: { kind: OperationKind; operationId: string; written: readonly string[] }[];
  aborted: { kind: OperationKind; operationId: string }[];
}

function core(overrides: Partial<CoreTemplateClient> = {}): {
  client: CoreTemplateClient;
  calls: Calls;
} {
  const calls: Calls = { finalized: [], aborted: [] };
  const capture: CaptureBegin = {
    operationId: OPERATION,
    templateId: TEMPLATE,
    bodyCopies: [],
    itemMappings: [],
  };
  const imported: ImportBegin = {
    operationId: OPERATION,
    templateId: TEMPLATE,
    unchanged: false,
    bodyWrites: [],
    itemMappings: [],
  };
  const application: ApplicationBegin = {
    applicationId: OPERATION,
    templateId: TEMPLATE,
    targetItemId: ROOT,
    alreadyApplied: false,
    createdItems: [],
    bodyCopies: [],
    itemMappings: [],
  };
  const client: CoreTemplateClient = {
    beginCapture: (_token, body) => {
      calls.beginBody = body;
      return Promise.resolve(capture);
    },
    beginImport: (_token, body) => {
      calls.beginBody = body;
      return Promise.resolve(imported);
    },
    beginApplication: (_token, body) => {
      calls.beginBody = body;
      return Promise.resolve(application);
    },
    authorizeOperationItem: () => Promise.reject(new Error('No body writes were planned.')),
    finalize: (_token, kind, operationId, written) => {
      calls.finalized.push({ kind, operationId, written });
      return Promise.resolve(
        kind === 'applications' ? { targetItemId: ROOT } : { templateId: TEMPLATE },
      );
    },
    abort: (_token, kind, operationId) => {
      calls.aborted.push({ kind, operationId });
      return Promise.resolve();
    },
    finalizeManaged: () => Promise.resolve({ activated: 0, unchanged: 0, retired: 0 }),
    sweepExpired: () => Promise.resolve({ removed: 0, itemIds: [] }),
    authorizeImport: (_token, workspaceId) =>
      Promise.resolve({
        workspaceId,
        tenantId: '55555555-5555-4555-8555-555555555555',
        principalId: '66666666-6666-4666-8666-666666666666',
        canWrite: true,
        canManageTemplates: false,
      }),
    beginDraft: () => Promise.reject(new Error('No draft was planned.')),
    getDraft: () => Promise.reject(new Error('No draft was planned.')),
    patchDraft: () => Promise.reject(new Error('No draft was planned.')),
    patchDraftItem: () => Promise.reject(new Error('No draft was planned.')),
    saveDraft: () => Promise.reject(new Error('No draft was planned.')),
    discardDraft: () => Promise.reject(new Error('No draft was planned.')),
    authorizeDraftItem: () => Promise.reject(new Error('No draft was planned.')),
    authorizeTemplateItem: () => Promise.reject(new Error('No export was planned.')),
    getTemplateExport: () => Promise.reject(new Error('No export was planned.')),
    ...overrides,
  };
  return { client, calls };
}

const unusedPool = {} as Pool;

describe('staged template orchestration', () => {
  it('finalizes a bodyless capture with the exact empty write set', async () => {
    const fake = core();
    const service = createTemplateService({ pool: unusedPool, core: fake.client });
    await service.capture('token', {
      workspaceId: WORKSPACE,
      sourceItemId: ROOT,
      title: 'Project',
      includeBody: false,
      includeChildren: false,
      idempotencyKey: 'capture-one',
    });

    expect(fake.calls.finalized).toEqual([
      { kind: 'captures', operationId: OPERATION, written: [] },
    ]);
    expect(fake.calls.aborted).toEqual([]);
  });

  it('aborts the stage when finalization fails', async () => {
    const fake = core({ finalize: () => Promise.reject(new Error('lost connection')) });
    const service = createTemplateService({ pool: unusedPool, core: fake.client });

    await expect(
      service.apply('token', {
        templateId: TEMPLATE,
        mode: 'merge',
        targetItemId: ROOT,
        idempotencyKey: 'apply-one',
      }),
    ).rejects.toThrow('lost connection');
    expect(fake.calls.aborted).toEqual([{ kind: 'applications', operationId: OPERATION }]);
  });

  it('passes the complete modern view snapshot in a validated import plan', async () => {
    const fake = core();
    const service = createTemplateService({ pool: unusedPool, core: fake.client });
    await service.importTemplate('token', importedTemplate());

    expect(fake.calls.beginBody).toMatchObject({
      template: { stableKey: 'team.project', origin: 'user', includeChildren: false },
      items: [
        {
          sourceId: ROOT,
          schema: {
            inherit: false,
            properties: [
              { key: 'workspace', label: 'Workspace', type: 'text', options: [], required: false },
              {
                key: 'status',
                label: 'Status',
                type: 'select',
                options: ['Open'],
                required: false,
              },
            ],
          },
          views: {
            views: [
              {
                filters: [{ property: 'status', operator: 'equals', value: 'Open' }],
                companionViewId: null,
                interactiveForm: null,
              },
            ],
          },
        },
      ],
    });
    expect(fake.calls.finalized[0]).toMatchObject({ kind: 'imports', written: [] });
  });

  it('returns an unchanged import without inventing or finalizing an operation', async () => {
    const fake = core({
      beginImport: () =>
        Promise.resolve({
          operationId: null,
          templateId: TEMPLATE,
          unchanged: true,
          bodyWrites: [],
          itemMappings: [],
        }),
    });
    const service = createTemplateService({ pool: unusedPool, core: fake.client });

    const result = await service.importTemplate('token', importedTemplate());

    expect(result).toMatchObject({ operationId: null, templateId: TEMPLATE, unchanged: true });
    expect(fake.calls.finalized).toEqual([]);
    expect(fake.calls.aborted).toEqual([]);
  });

  it('finalizes an already-applied application so its no-op stage cannot leak', async () => {
    const fake = core({
      beginApplication: () =>
        Promise.resolve({
          applicationId: OPERATION,
          templateId: TEMPLATE,
          targetItemId: ROOT,
          alreadyApplied: true,
          createdItems: [],
          bodyCopies: [],
          itemMappings: [],
        }),
    });
    const service = createTemplateService({ pool: unusedPool, core: fake.client });

    const result = await service.apply('token', {
      templateId: TEMPLATE,
      mode: 'merge',
      targetItemId: ROOT,
      idempotencyKey: 'apply-again',
    });

    expect(result).toMatchObject({ alreadyApplied: true, writtenTargetItemIds: [] });
    expect(fake.calls.finalized).toEqual([
      { kind: 'applications', operationId: OPERATION, written: [] },
    ]);
  });

  it('seals every resident draft body before Core atomically activates the draft', async () => {
    const draft = bodylessDraft();
    const events: string[] = [];
    const fake = core({
      beginDraft: () => Promise.resolve(draft),
      getDraft: () => Promise.resolve(draft),
      saveDraft: () => {
        events.push('save');
        return Promise.resolve({ templateId: TEMPLATE });
      },
    });
    const service = createTemplateService({
      pool: unusedPool,
      core: fake.client,
      sealItems: (itemIds) => {
        events.push(`seal:${itemIds.join(',')}`);
        return Promise.resolve();
      },
      blockDraftAuthorization: (operationId) => {
        events.push(`block-auth:${operationId}`);
      },
      completeDraftAuthorization: (operationId) => {
        events.push(`complete-auth:${operationId}`);
      },
      releaseDraftAuthorization: (operationId) => {
        events.push(`release-auth:${operationId}`);
      },
    });

    await service.beginDraft('token', TEMPLATE, 'draft-one');
    await service.saveDraft('token', TEMPLATE, OPERATION);

    expect(events).toEqual([
      `block-auth:${OPERATION}`,
      `seal:${ROOT}`,
      'save',
      `complete-auth:${OPERATION}`,
    ]);
  });

  it('seals draft body rooms before Core discards their hidden envelopes', async () => {
    const draft = bodylessDraft();
    const events: string[] = [];
    const fake = core({
      getDraft: () => Promise.resolve(draft),
      discardDraft: () => {
        events.push('discard');
        return Promise.resolve();
      },
    });
    const service = createTemplateService({
      pool: unusedPool,
      core: fake.client,
      sealItems: (itemIds) => {
        events.push(`seal:${itemIds.join(',')}`);
        return Promise.resolve();
      },
      blockDraftAuthorization: (operationId) => {
        events.push(`block-auth:${operationId}`);
      },
      completeDraftAuthorization: (operationId) => {
        events.push(`complete-auth:${operationId}`);
      },
    });

    await service.discardDraft('token', TEMPLATE, OPERATION);

    expect(events).toEqual([
      `block-auth:${OPERATION}`,
      `seal:${ROOT}`,
      'discard',
      `complete-auth:${OPERATION}`,
    ]);
  });

  it('releases the authorization fence after Core explicitly refuses Save', async () => {
    const draft = bodylessDraft();
    const events: string[] = [];
    const fake = core({
      getDraft: () => Promise.resolve(draft),
      saveDraft: () => {
        events.push('save');
        return Promise.reject(new CoreTemplateError(409, 'template.conflict', 'Not saved.'));
      },
    });
    const service = createTemplateService({
      pool: unusedPool,
      core: fake.client,
      sealItems: () => Promise.resolve(),
      blockDraftAuthorization: () => {
        events.push('block');
      },
      releaseDraftAuthorization: () => {
        events.push('release');
      },
    });

    await expect(service.saveDraft('token', TEMPLATE, OPERATION)).rejects.toMatchObject({
      status: 409,
    });
    expect(events).toEqual(['block', 'save', 'release']);
  });

  it('keeps the authorization fence after an ambiguous Save failure', async () => {
    const draft = bodylessDraft();
    const events: string[] = [];
    const fake = core({
      getDraft: () => Promise.resolve(draft),
      saveDraft: () => {
        events.push('save');
        return Promise.reject(
          new CoreTemplateError(503, 'template.core_unavailable', 'Core did not answer.'),
        );
      },
    });
    const service = createTemplateService({
      pool: unusedPool,
      core: fake.client,
      sealItems: () => Promise.resolve(),
      blockDraftAuthorization: () => {
        events.push('block');
      },
      releaseDraftAuthorization: () => {
        events.push('release');
      },
    });

    await expect(service.saveDraft('token', TEMPLATE, OPERATION)).rejects.toMatchObject({
      status: 503,
    });
    expect(events).toEqual(['block', 'save']);
  });

  it('invalidates expired body rooms after Core removes their hidden envelopes', async () => {
    const events: string[] = [];
    const fake = core({
      sweepExpired: () => {
        events.push('sweep');
        return Promise.resolve({ removed: 1, itemIds: [ROOT] });
      },
    });
    const service = createTemplateService({
      pool: unusedPool,
      core: fake.client,
      invalidateItems: (itemIds) => {
        events.push(`invalidate:${itemIds.join(',')}`);
        return Promise.resolve();
      },
    });

    await expect(service.sweepExpired('token', WORKSPACE)).resolves.toEqual({
      removed: 1,
      itemIds: [ROOT],
    });
    expect(events).toEqual(['sweep', `invalidate:${ROOT}`]);
  });
});

function bodylessDraft(): TemplateDraft {
  return {
    operationId: OPERATION,
    templateId: TEMPLATE,
    title: 'Project',
    description: null,
    expiresAt: '2026-08-17T12:00:00Z',
    root: {
      sourceId: ROOT,
      itemType: 'note',
      title: 'Project',
      seq: '1',
      properties: {},
      schema: null,
      views: null,
      hasBody: false,
      children: [],
    },
    itemMappings: [{ sourceId: TEMPLATE, itemId: ROOT, itemType: 'note' }],
    bodyCopies: [],
  };
}

function importedTemplate(): {
  manifest: ArchiveManifest;
  bundles: readonly ItemBundle[];
  profile: TemplateArchiveProfile;
  digest: string;
  workspaceId: string;
  origin: 'user';
  idempotencyKey: string;
} {
  const profile: TemplateArchiveProfile = {
    kind: 'template',
    version: 1,
    key: 'team.project',
    name: 'Team project',
    description: '',
    includeBody: false,
    includeChildren: false,
  };
  const manifest: ArchiveManifest = {
    format: 'nix-archive',
    formatVersion: 1,
    schemaVersion: 2,
    profile,
    exportedAt: '2026-08-16T12:00:00Z',
    root: ROOT,
    rootEffectiveSchema: {
      properties: [
        { key: 'workspace', label: 'Workspace', type: 'text', options: [], required: false },
        { key: 'status', label: 'Status', type: 'select', options: ['Open'], required: false },
      ],
      declared: [
        { key: 'status', label: 'Status', type: 'select', options: ['Open'], required: false },
      ],
      inherit: true,
    },
    includesDeleted: false,
    items: [{ id: ROOT, parentId: null, type: 'note', title: 'Project', seq: '1' }],
    omitted: [],
    loss: [],
  };
  const bundle: ItemBundle = {
    id: ROOT,
    parentId: null,
    workspaceId: WORKSPACE,
    type: 'note',
    title: 'Project',
    seq: '1',
    lifecycleState: 'active',
    createdAt: manifest.exportedAt,
    updatedAt: manifest.exportedAt,
    properties: {},
    schema: {
      properties: [
        { key: 'workspace', label: 'Workspace', type: 'text', options: [], required: false },
        { key: 'status', label: 'Status', type: 'select', options: ['Open'], required: false },
      ],
      declared: [
        { key: 'status', label: 'Status', type: 'select', options: ['Open'], required: false },
      ],
      inherit: true,
    },
    viewRows: [],
    viewRowsTruncated: false,
    body: null,
    views: {
      default: 'all',
      views: [
        {
          id: 'all',
          name: 'All',
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
          filters: [{ property: 'status', operator: 'equals', value: 'Open' }],
          companionViewId: null,
          companionPlacement: null,
          interactiveForm: null,
        },
      ],
    },
  };
  return {
    manifest,
    bundles: [bundle],
    profile,
    digest: 'a'.repeat(64),
    workspaceId: WORKSPACE,
    origin: 'user',
    idempotencyKey: 'import-one',
  };
}
