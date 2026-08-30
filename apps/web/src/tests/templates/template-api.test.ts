import { createNixClient, templateDetailSchema, templates } from '@nix/api-client';
import { describe, expect, it } from 'vitest';

import {
  importTemplateFile,
  previewTemplateFile,
  TemplateImportPreviewSchema,
  updateTemplateEditDraftItem,
} from '../../templates/template-api';
import { STUB_TEMPLATES, stubCoreApi } from '../api-stub';

const TEMPLATE_WORKSPACE_ID = 'a1000000-0000-4000-8000-000000000001';

function client() {
  return createNixClient({
    baseUrl: globalThis.location.origin,
    tokens: {
      getAccessToken: () => null,
      refreshAccessToken: () => Promise.resolve(null),
    },
  });
}

describe('the template API boundary', () => {
  it('parses the workspace template summaries returned by Core', async () => {
    stubCoreApi();

    const library = await client().query(templates.listTemplates(TEMPLATE_WORKSPACE_ID));

    expect(library.templates.map((template) => template.title)).toEqual(
      STUB_TEMPLATES.map((template) => template.title),
    );
    expect(library.capabilities.canManage).toBe(true);
  });

  it('sends a template archive as binary data for validation', () => {
    const archive = new File(['archive'], 'daily-check-in.nix', {
      type: 'application/x-nix-template',
    });

    const endpoint = previewTemplateFile(TEMPLATE_WORKSPACE_ID, archive);

    expect(endpoint.body).toBe(archive);
    expect(endpoint.path).toBe('/media/templates/preview');
    expect(endpoint.query).toEqual({ workspaceId: TEMPLATE_WORKSPACE_ID });
  });

  it('binds a commit to both the preview digest and one logical attempt', () => {
    const archive = new Blob(['archive']);
    const endpoint = importTemplateFile(TEMPLATE_WORKSPACE_ID, archive, 'digest', 'attempt-one');

    expect(endpoint.headers).toEqual({
      'x-nix-template-digest': 'digest',
      'x-idempotency-key': 'attempt-one',
    });
  });

  it('rejects a preview that does not carry a template profile', () => {
    const result = TemplateImportPreviewSchema.safeParse({
      digest: 'abc123',
      itemCount: 1,
      bodyCount: 0,
      viewCount: 0,
    });

    expect(result.success).toBe(false);
  });

  it('normalizes Core stored schemas and sparse stored views for template use', () => {
    const detail = templateDetailSchema.parse({
      ...STUB_TEMPLATES[0],
      root: {
        sourceId: 'a1111111-1111-4111-8111-111111111110',
        itemType: 'note',
        title: 'Delivery board',
        seq: '1000',
        properties: {},
        schema: {
          inherit: false,
          properties: [{ key: 'status', label: 'Status', type: 'select', required: false }],
        },
        views: {
          default: 'board',
          views: [{ id: 'board', name: 'Board', kind: 'board', groupBy: 'status' }],
        },
        children: [],
        hasBody: false,
      },
    });

    expect(detail.root.schema).toEqual({
      inherit: false,
      properties: [
        { key: 'status', label: 'Status', type: 'select', options: [], required: false },
      ],
      declared: [{ key: 'status', label: 'Status', type: 'select', options: [], required: false }],
    });
    expect(detail.root.views?.views[0]).toMatchObject({
      id: 'board',
      columns: [],
      groupOrder: [],
      dateProperty: null,
      sortDescending: false,
      companionViewId: null,
    });
  });

  it('writes only a draft item schema declaration back to Core', () => {
    const endpoint = updateTemplateEditDraftItem(
      'a1111111-1111-4111-8111-111111111111',
      'a2222222-2222-4222-8222-222222222222',
      'a3333333-3333-4333-8333-333333333333',
      {
        schema: {
          properties: [
            { key: 'owner', label: 'Owner', type: 'text', options: [], required: false },
            { key: 'status', label: 'Status', type: 'text', options: [], required: false },
          ],
          declared: [
            { key: 'status', label: 'Status', type: 'text', options: [], required: false },
          ],
          inherit: true,
        },
      },
    );

    expect(endpoint.body).toEqual({
      schema: {
        properties: [
          { key: 'status', label: 'Status', type: 'text', options: [], required: false },
        ],
        inherit: true,
      },
    });
  });
});
