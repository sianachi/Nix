import { SCHEMA_VERSION } from '@nix/editor-schema';
import { describe, expect, it } from 'vitest';

import {
  parseApplicationRequest,
  parseCaptureRequest,
  parseDraftMetadataPatch,
  parseDraftItemPatch,
  parseImportedTemplate,
  parseManagedFinalizeRequest,
} from './http-contracts.ts';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ITEM = '22222222-2222-4222-8222-222222222222';

describe('the collaboration template HTTP contracts', () => {
  it.each([
    { label: 'null', description: null, expected: { description: null } },
    {
      label: 'text',
      description: 'A useful starting point.',
      expected: { description: 'A useful starting point.' },
    },
    { label: 'omitted', description: undefined, expected: {} },
  ])('accepts and preserves a $label capture description', ({ description, expected }) => {
    expect(
      parseCaptureRequest({
        workspaceId: WORKSPACE,
        sourceItemId: ITEM,
        title: 'Project',
        ...(description === undefined ? {} : { description }),
        includeBody: false,
        includeChildren: false,
        idempotencyKey: 'capture-one',
      }),
    ).toEqual({
      workspaceId: WORKSPACE,
      sourceItemId: ITEM,
      title: 'Project',
      ...expected,
      includeBody: false,
      includeChildren: false,
      idempotencyKey: 'capture-one',
    });
  });

  it('refuses a capture whose options have the wrong runtime type', () => {
    expect(
      caught(() =>
        parseCaptureRequest({
          workspaceId: WORKSPACE,
          sourceItemId: ITEM,
          title: 'Project',
          includeBody: 'yes',
          includeChildren: false,
          idempotencyKey: 'capture-one',
        }),
      ),
    ).toMatchObject({ status: 400, code: 'template.capture_invalid' });
  });

  it.each([
    { field: 'description', value: 42 },
    { field: 'description', value: { text: 'Project' } },
    { field: 'title', value: null },
  ])('refuses a capture with invalid $field input', ({ field, value }) => {
    expect(
      caught(() =>
        parseCaptureRequest({
          workspaceId: WORKSPACE,
          sourceItemId: ITEM,
          title: 'Project',
          description: null,
          includeBody: false,
          includeChildren: false,
          idempotencyKey: 'capture-one',
          [field]: value,
        }),
      ),
    ).toMatchObject({ status: 400, code: 'template.capture_invalid' });
  });

  it('refuses an application with a malformed destination identifier', () => {
    expect(
      caught(() =>
        parseApplicationRequest({
          templateId: ITEM,
          mode: 'merge',
          targetItemId: 'not-an-item',
          idempotencyKey: 'apply-one',
        }),
      ),
    ).toMatchObject({ code: 'template.application_invalid' });
  });

  it('preserves an explicit root destination on a template application', () => {
    expect(
      parseApplicationRequest({
        templateId: ITEM,
        mode: 'create',
        parentItemId: null,
        title: 'Project',
        idempotencyKey: 'apply-one',
      }),
    ).toMatchObject({ parentItemId: null });
  });

  it('preserves nullable draft metadata and refuses non-text values', () => {
    expect(parseDraftMetadataPatch({ title: 'Project', description: null })).toEqual({
      title: 'Project',
      description: null,
    });
    expect(caught(() => parseDraftMetadataPatch({ description: 42 }))).toMatchObject({
      status: 400,
      code: 'template.draft_invalid',
    });
  });

  it('copies only declared draft item fields across the HTTP boundary', () => {
    expect(
      parseDraftItemPatch({
        title: 'Updated',
        properties: { status: 'Open' },
        publicationState: 'published',
      }),
    ).toEqual({ title: 'Updated', properties: { status: 'Open' } });
  });

  it('refuses an import plan before archive code can trust an incomplete manifest', () => {
    expect(
      caught(() =>
        parseImportedTemplate({
          manifest: {},
          bundles: [],
          profile: {},
          digest: '0'.repeat(64),
          workspaceId: WORKSPACE,
          origin: 'user',
          idempotencyKey: 'import-one',
        }),
      ),
    ).toMatchObject({ code: 'template.import_invalid' });
  });

  it('refuses malformed nested archive data forwarded by Media', () => {
    const request = validImport();
    const root = request.bundles[0];
    if (root === undefined) throw new Error('The import fixture needs a root bundle.');

    expect(
      caught(() =>
        parseImportedTemplate({
          ...request,
          bundles: [
            {
              ...root,
              views: {
                default: 'form',
                views: [
                  {
                    id: 'form',
                    name: 'Form',
                    kind: 'interactive_form',
                    columns: [],
                    groupOrder: [],
                    sortDescending: false,
                    interactiveForm: { pages: 'not-pages' },
                  },
                ],
              },
            },
          ],
        }),
      ),
    ).toMatchObject({ status: 400, code: 'template.import_invalid' });
  });

  it('refuses malformed staged entries in a managed finalization request', () => {
    expect(
      caught(() =>
        parseManagedFinalizeRequest({
          imports: [
            {
              operationId: 'not-an-operation',
              templateId: ITEM,
              stableKey: 'managed.project',
              digest: '0'.repeat(64),
              unchanged: false,
              writtenTargetItemIds: [],
            },
          ],
          activeStableKeys: ['managed.project'],
        }),
      ),
    ).toMatchObject({ code: 'template.finalize_invalid' });
  });
});

function caught(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the contract parser to refuse the value.');
}

function validImport(): Record<string, unknown> & { bundles: readonly Record<string, unknown>[] } {
  const profile = {
    kind: 'template',
    version: 1,
    key: 'team.project',
    name: 'Team project',
    description: '',
    includeBody: false,
    includeChildren: false,
  } as const;
  return {
    manifest: {
      format: 'nix-archive',
      formatVersion: 1,
      schemaVersion: SCHEMA_VERSION,
      profile,
      exportedAt: '2026-08-17T10:00:00.000Z',
      root: ITEM,
      rootEffectiveSchema: null,
      includesDeleted: false,
      items: [{ id: ITEM, parentId: null, seq: '1000', title: 'Project', type: 'note' }],
      omitted: [],
      loss: [],
    },
    bundles: [
      {
        id: ITEM,
        parentId: null,
        workspaceId: WORKSPACE,
        type: 'note',
        title: 'Project',
        seq: '1000',
        lifecycleState: 'active',
        createdAt: '2026-08-17T10:00:00.000Z',
        updatedAt: '2026-08-17T10:00:00.000Z',
        properties: {},
        schema: null,
        views: null,
        viewRows: [],
        viewRowsTruncated: false,
        body: null,
      },
    ],
    profile,
    digest: '0'.repeat(64),
    workspaceId: WORKSPACE,
    origin: 'user',
    idempotencyKey: 'import-one',
  };
}
