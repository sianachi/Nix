import { describe, expect, it } from 'vitest';

import { templateImportSchema, templateImportUploadSchema } from './template-imports.js';

const IMPORT_ID = 'a1111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = 'a2222222-2222-4222-8222-222222222222';
const TEMPLATE_ID = 'a3333333-3333-4333-8333-333333333333';
const DIGEST = 'a'.repeat(64);

describe('the template import schemas', () => {
  it('parses the nullable upload capability returned for a durable replay', () => {
    const upload = templateImportUploadSchema.parse({
      id: IMPORT_ID,
      status: 'preview_ready',
      uploadUrl: null,
      capabilityExpiresAt: null,
      expiresAt: '2026-09-01T11:00:00Z',
    });

    expect(upload.uploadUrl).toBeNull();
    expect(upload.status).toBe('preview_ready');
  });

  it('parses preview and result state from one durable response', () => {
    const operation = templateImportSchema.parse({
      id: IMPORT_ID,
      workspaceId: WORKSPACE_ID,
      status: 'completed',
      previewOperationId: 'a4444444-4444-4444-8444-444444444444',
      commitOperationId: 'a5555555-5555-4555-8555-555555555555',
      preview: {
        profile: {
          kind: 'template',
          version: 1,
          key: 'weekly-review',
          name: 'Weekly review',
          description: 'A compact weekly review.',
          includeBody: true,
          includeChildren: false,
        },
        digest: DIGEST,
        rootItemType: 'note',
        itemCount: 1,
        bodyCount: 1,
        viewCount: 0,
      },
      result: {
        operationId: null,
        templateId: TEMPLATE_ID,
        stableKey: 'weekly-review',
        digest: DIGEST,
        unchanged: false,
        writtenTargetItemIds: [],
      },
      failureCode: null,
      expiresAt: '2026-09-01T11:00:00Z',
      completedAt: '2026-09-01T10:01:00Z',
    });

    expect(operation.preview?.profile.kind).toBe('template');
    expect(operation.result?.templateId).toBe(TEMPLATE_ID);
  });

  it('rejects a preview digest that is not the worker SHA-256 value', () => {
    const result = templateImportSchema.safeParse({
      id: IMPORT_ID,
      workspaceId: WORKSPACE_ID,
      status: 'preview_ready',
      previewOperationId: null,
      commitOperationId: null,
      preview: {
        profile: {
          kind: 'template',
          version: 1,
          key: 'weekly-review',
          name: 'Weekly review',
          description: '',
          includeBody: false,
          includeChildren: false,
        },
        digest: 'not-a-digest',
        rootItemType: 'note',
        itemCount: 1,
        bodyCount: 0,
        viewCount: 0,
      },
      result: null,
      failureCode: null,
      expiresAt: '2026-09-01T11:00:00Z',
      completedAt: null,
    });

    expect(result.success).toBe(false);
  });
});
