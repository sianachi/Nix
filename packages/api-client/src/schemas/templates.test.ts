import { describe, expect, it } from 'vitest';

import { templateCatalogSchema, templateDetailSchema } from './templates.js';

const TEMPLATE = {
  id: 'a1111111-1111-4111-8111-111111111111',
  workspaceId: 'a1000000-0000-4000-8000-000000000001',
  title: 'Delivery board',
  description: null,
  origin: 'user',
  revision: '2',
  includeBody: false,
  includeChildren: true,
  fieldCount: '1',
  viewCount: '1',
  childCount: '0',
  viewKinds: ['board'],
  capabilities: { canEdit: true, canDelete: true, canExport: true, canApply: true },
  updatedAt: '2026-08-17T09:00:00+00:00',
} as const;

describe('the template schemas', () => {
  it('accepts the integer string representation published by the generated contract', () => {
    const catalog = templateCatalogSchema.parse({
      templates: [TEMPLATE],
      capabilities: { canManage: true },
    });

    expect(catalog.templates[0]).toMatchObject({
      revision: 2,
      fieldCount: 1,
      viewCount: 1,
      childCount: 0,
    });
  });

  it('normalizes captured schemas and additive view fields at the boundary', () => {
    const detail = templateDetailSchema.parse({
      ...TEMPLATE,
      root: {
        sourceId: 'a2111111-1111-4111-8111-111111111111',
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
      companionViewId: null,
      interactiveForm: null,
    });
  });

  it('accepts every typed composition and interactive-form field from the contract', () => {
    const detail = templateDetailSchema.parse({
      ...TEMPLATE,
      root: {
        sourceId: 'a2111111-1111-4111-8111-111111111111',
        itemType: 'note',
        title: 'Daily tracker',
        seq: '1000',
        properties: {},
        schema: {
          inherit: true,
          properties: [
            { key: 'mood', label: 'Mood', type: 'select', options: ['Good'], required: true },
          ],
          declared: [
            { key: 'mood', label: 'Mood', type: 'select', options: ['Good'], required: true },
          ],
        },
        views: {
          default: null,
          views: [
            {
              id: 'form',
              name: 'Check in',
              kind: 'interactive_form',
              columns: ['title', 'mood'],
              groupBy: null,
              groupOrder: [],
              dateProperty: null,
              sortBy: 'title',
              sortDescending: true,
              mode: null,
              coverProperty: null,
              endDateProperty: null,
              cardSize: null,
              filters: [{ property: 'mood', operator: 'equals', value: 'Good' }],
              companionViewId: 'responses',
              companionPlacement: 'beside',
              interactiveForm: {
                pages: [
                  {
                    id: 'daily',
                    title: 'Daily check-in',
                    description: 'One minute',
                    visibleWhen: [],
                    blocks: [
                      {
                        id: 'mood-question',
                        kind: 'field',
                        propertyKey: 'mood',
                        text: 'How are you?',
                        help: null,
                        required: true,
                        identityRole: null,
                        visibleWhen: [
                          { fieldBlockId: 'earlier', operator: 'equals', value: 'yes' },
                        ],
                      },
                    ],
                  },
                ],
                titleMode: 'selected',
                titleFieldBlockId: 'mood-question',
                confirmationTitle: 'Saved',
                confirmationMessage: 'See you tomorrow.',
              },
            },
          ],
        },
        children: [],
        hasBody: false,
      },
    });

    expect(detail.root.views?.default).toBe('document');
    expect(detail.root.views?.views[0]?.interactiveForm?.pages[0]?.blocks[0]).toMatchObject({
      id: 'mood-question',
      propertyKey: 'mood',
      required: true,
    });
    expect(detail.root.views?.views[0]?.filters).toEqual([
      { property: 'mood', operator: 'equals', value: 'Good' },
    ]);
  });
});
