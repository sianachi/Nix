import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  templateCatalogSchema,
  templateDetailSchema,
  templateInitializationSchema,
  templatePreflightRequestSchema,
} from './templates.js';

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
  it('accepts the shared v1 archive and Core wire fixture', () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL('../../../../fixtures/template-initialization-v1.json', import.meta.url),
        'utf8',
      ),
    ) as unknown;
    if (typeof fixture !== 'object' || fixture === null || Array.isArray(fixture)) {
      throw new Error('The shared template initialization fixture must be an object.');
    }

    const parsed = templateInitializationSchema.parse(fixture);
    expect(parsed).toMatchObject(fixture);
    expect(parsed.inputs.find((input) => input.key === 'start_date')?.defaultValue).toBeNull();
    const relativeDateRule = parsed.rules.find(
      (rule) => rule.kind === 'relativeDate' && rule.propertyKey === 'recurrence.until',
    );
    expect(relativeDateRule).toMatchObject({ timeOfDay: null, timeZone: null });
  });

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

  it('validates versioned inputs, explicit property rules, and external reference policies', () => {
    const initialization = templateInitializationSchema.parse({
      version: 1,
      inputs: [
        { key: 'start', label: 'Start date', type: 'date', required: true },
        { key: 'owner', label: 'Project lead', type: 'member', required: true },
        { key: 'related', label: 'Related item', type: 'item', required: false },
      ],
      rules: [
        {
          sourceId: 'a2111111-1111-4111-8111-111111111111',
          propertyKey: 'due_date',
          kind: 'relativeDate',
          inputKey: 'start',
          offsetDays: 7,
        },
        {
          sourceId: 'a2111111-1111-4111-8111-111111111111',
          propertyKey: 'assignee',
          kind: 'input',
          inputKey: 'owner',
        },
        {
          sourceId: 'a2111111-1111-4111-8111-111111111111',
          propertyKey: 'completion',
          kind: 'set',
          value: false,
        },
      ],
      references: [
        {
          sourceItemId: 'a3111111-1111-4111-8111-111111111111',
          policy: 'replace',
          inputKey: 'related',
        },
        { sourceItemId: 'a4111111-1111-4111-8111-111111111111', policy: 'omit' },
      ],
    });

    expect(initialization.rules[0]).toMatchObject({ kind: 'relativeDate', offsetDays: 7 });
    expect(initialization.references[0]).toMatchObject({ policy: 'replace', inputKey: 'related' });
  });

  it('rejects duplicate and mismatched initialization rules and missing set values', () => {
    const sourceId = 'a2111111-1111-4111-8111-111111111111';
    const valid = {
      version: 1,
      inputs: [{ key: 'start', label: 'Start', type: 'text', required: true }],
      rules: [
        {
          sourceId,
          propertyKey: 'due_date',
          kind: 'relativeDate',
          inputKey: 'start',
          offsetDays: 1,
        },
      ],
      references: [],
    };
    expect(templateInitializationSchema.safeParse(valid).success).toBe(false);
    expect(
      templateInitializationSchema.safeParse({
        version: 1,
        inputs: [],
        rules: [{ sourceId, propertyKey: 'completion', kind: 'set' }],
        references: [],
      }).success,
    ).toBe(false);
    expect(
      templateInitializationSchema.safeParse({
        version: 1,
        inputs: [
          { key: 'owner', label: 'Owner', type: 'member', required: true },
          { key: 'start', label: 'Start', type: 'date', required: true },
        ],
        rules: [
          {
            sourceId,
            propertyKey: 'due_date',
            kind: 'relativeDate',
            inputKey: 'start',
            offsetDays: 1,
          },
          { sourceId, propertyKey: 'due_date', kind: 'clear' },
        ],
        references: [
          {
            sourceItemId: 'a3111111-1111-4111-8111-111111111111',
            policy: 'replace',
            inputKey: 'start',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('keeps server revision and submitted inputs on the preflight wire request', () => {
    expect(
      templatePreflightRequestSchema.parse({
        mode: 'create',
        title: 'Project',
        inputs: { name: 'Q4' },
        expectedRevision: 3,
      }),
    ).toEqual({
      mode: 'create',
      targetItemId: null,
      parentItemId: null,
      title: 'Project',
      inputs: { name: 'Q4' },
      expectedRevision: 3,
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
        {
          key: 'status',
          label: 'Status',
          type: 'select',
          options: [],
          required: false,
          expression: null,
          aggregate: null,
          source: null,
        },
      ],
      declared: [
        {
          key: 'status',
          label: 'Status',
          type: 'select',
          options: [],
          required: false,
          expression: null,
          aggregate: null,
          source: null,
        },
      ],
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
