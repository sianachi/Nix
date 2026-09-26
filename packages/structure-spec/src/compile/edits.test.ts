import { describe, expect, it } from 'vitest';

import type { StructureProperty, StructureView } from '../types.js';
import { compileAddFields, compileEditForm, compileRecurrence } from './edits.js';

const nameField: StructureProperty = {
  key: 'name',
  label: 'Name',
  type: 'text',
  options: [],
  required: false,
};

function view(overrides: Partial<StructureView> = {}): StructureView {
  return {
    id: 'form',
    name: 'Intake',
    kind: 'interactive_form',
    columns: ['title'],
    groupBy: null,
    groupOrder: [],
    dateProperty: null,
    sortBy: null,
    sortDescending: false,
    mode: null,
    coverProperty: null,
    endDateProperty: null,
    cardSize: null,
    layout: null,
    filters: [],
    interactiveForm: {
      pages: [
        {
          id: 'p1',
          title: 'Details',
          description: null,
          visibleWhen: [],
          blocks: [
            {
              id: 'b1',
              kind: 'field',
              propertyKey: 'name',
              text: 'Name',
              help: null,
              required: false,
              identityRole: null,
              visibleWhen: [],
            },
          ],
        },
      ],
      titleMode: 'generated',
      titleFieldBlockId: null,
      confirmationTitle: 'Thanks',
      confirmationMessage: 'Received',
    },
    ...overrides,
  };
}

describe('compileAddFields', () => {
  it('compiles to an additive schema step with no views', () => {
    const [step] = compileAddFields(
      { fields: [{ label: 'Rating', type: 'number' }] },
      { itemId: 'item-1', existing: { effective: [nameField] } },
    );

    expect(step).toMatchObject({
      kind: 'appendViewSetup',
      itemId: 'item-1',
      properties: [{ key: 'rating', label: 'Rating', type: 'number' }],
      views: [],
      makeDefault: false,
    });
  });
});

describe('compileEditForm', () => {
  it('keeps the companion view and current inherit flag', () => {
    const target = view({ companionViewId: 'responses', companionPlacement: 'below' });
    const companion = view({
      id: 'responses',
      name: 'Responses',
      kind: 'list',
      interactiveForm: null,
      companionViewId: 'form',
      companionPlacement: 'below',
    });
    const [step] = compileEditForm(
      {
        viewId: 'form',
        fields: [{ label: 'Rating', type: 'number' }],
        form: {
          pages: [{ title: 'Details', blocks: [{ field: 'name' }, { field: 'Rating' }] }],
        },
      },
      {
        itemId: 'item-1',
        existing: {
          declared: [nameField],
          inherit: false,
          effective: [nameField],
          views: [target, companion],
        },
        view: target,
      },
    );

    expect(step).toMatchObject({
      kind: 'replaceViewSetup',
      itemId: 'item-1',
      viewId: 'form',
      schema: { properties: [{ key: 'rating' }], inherit: false },
      originalPropertyKeys: [],
    });
    if (step?.kind !== 'replaceViewSetup') throw new Error('expected replaceViewSetup');
    expect(step.views[0]).toMatchObject({ id: 'form', name: 'Intake', kind: 'interactive_form' });
    expect(step.views[1]).toEqual(companion);
    expect(
      step.views[0]?.interactiveForm?.pages[0]?.blocks.map((block) => block.propertyKey),
    ).toEqual(['name', 'rating']);
  });

  it('refuses a board view', () => {
    const board = view({ id: 'board', kind: 'board', interactiveForm: null });
    expect(() =>
      compileEditForm(
        { viewId: 'board', form: { pages: [{ title: 'Details', blocks: [{ heading: 'Info' }] }] } },
        {
          itemId: 'item-1',
          existing: { declared: [], inherit: true, effective: [], views: [board] },
          view: board,
        },
      ),
    ).toThrow(/not an interactive form/);
  });
});

describe('compileRecurrence', () => {
  it('keeps weekdays for weekly recurrence and drops them for monthly recurrence', () => {
    const weekly = compileRecurrence(
      { frequency: 'weekly', interval: 2, weekdays: [1, 4] },
      { itemId: 'item-1' },
    );
    expect(weekly[0]).toMatchObject({
      kind: 'setRecurrence',
      target: { itemId: 'item-1' },
      rule: { freq: 'weekly', interval: 2, weekdays: [1, 4], until: null },
    });

    const monthly = compileRecurrence(
      { frequency: 'monthly', interval: 1, weekdays: [1, 4] },
      { itemId: 'item-1' },
    );
    expect(monthly[0]).toMatchObject({
      kind: 'setRecurrence',
      rule: { freq: 'monthly', weekdays: null },
    });
  });
});
