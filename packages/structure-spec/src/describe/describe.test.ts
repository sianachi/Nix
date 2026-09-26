import { describe, expect, it } from 'vitest';

import { compileAddView, compileCreateStructured, compileEntries } from '../compile/operations.js';
import { STEP_KINDS, type Step } from '../compile/steps.js';
import type { StructureProperty, StructureView } from '../types.js';
import { describeStep, describeSteps, type DescribeContext } from './steps.js';

function context(overrides: Partial<DescribeContext> = {}): DescribeContext {
  return {
    destination: { title: 'Workspace', path: [] },
    problems: [],
    warnings: [],
    ...overrides,
  };
}

describe('describeSteps', () => {
  it('produces the create_structured headline from architecture section 7', () => {
    const steps = compileCreateStructured(
      {
        recipe: 'board',
        fields: [
          { label: 'Status', type: 'select', options: ['To read', 'Reading', 'Done'] },
          { label: 'Rating', type: 'number' },
        ],
        views: [{ kind: 'board', groupBy: 'Status' }],
        inherit: true,
      },
      { parentId: 'books-id', title: 'Reading log', inheritedFields: [] },
    );

    const model = describeSteps(
      steps,
      context({ destination: { title: 'Books', path: ['Books'] } }),
    );

    expect(model.headline).toBe(
      'I will create the board Reading log inside Books with Status (To read, Reading, Done), Rating (number) and a Board view grouped by Status.',
    );
    expect(model.counts).toEqual({ items: 1, fields: 2, views: 1, entries: 0, writes: 1 });
  });

  it('produces the add_view headline from architecture section 7', () => {
    const steps = compileAddView(
      {
        fields: [
          { label: 'Title', type: 'text' },
          { label: 'Rating', type: 'number' },
          { label: 'Notes', type: 'text' },
        ],
        views: [
          {
            kind: 'interactive_form',
            form: {
              pages: [
                {
                  title: 'Page 1',
                  blocks: [{ field: 'Title' }, { field: 'Rating' }, { field: 'Notes' }],
                },
              ],
            },
          },
        ],
      },
      { itemId: 'item-1', existing: { declared: [], effective: [], views: [] } },
    );

    const model = describeSteps(
      steps,
      context({ destination: { title: 'Reading log', path: ['Books', 'Reading log'] } }),
    );

    expect(model.headline).toBe(
      'I will add a Form view to Reading log. It asks for Title, Rating and Notes. Existing fields and the note body stay unchanged.',
    );
  });

  it('describes create_entries as one node per entry, with counts matching the steps', () => {
    const steps = compileEntries(
      {
        entries: [
          { title: 'War and Peace', values: { rating: 5 }, sample: true },
          { title: 'Dune', markdown: 'A desert planet.' },
        ],
      },
      { parentId: 'books-id' },
    );

    const model = describeSteps(
      steps,
      context({ destination: { title: 'Books', path: ['Books'] } }),
    );

    expect(model.headline).toBe('I will add 2 entries to Books.');
    expect(model.tree).toHaveLength(2);
    expect(model.tree[0]?.label).toBe('Sample: War and Peace');
    expect(model.tree[1]?.label).toBe('Dune');
    expect(model.tree[1]?.detail).toContain('A desert planet.');
    expect(model.counts).toEqual({ items: 2, fields: 0, views: 0, entries: 2, writes: 3 });
  });

  it('shows entry values in effective field order using their field labels', () => {
    const steps = compileEntries(
      { entries: [{ title: 'Dune', values: { rating: 5, status: 'Reading' } }] },
      { parentId: 'books-id' },
    );
    const fields: StructureProperty[] = [
      { key: 'status', label: 'Status', type: 'select', options: ['Reading'], required: false },
      { key: 'rating', label: 'Rating', type: 'number', options: [], required: false },
    ];

    const model = describeSteps(
      steps,
      context({
        destination: { title: 'Books', path: ['Books'] },
        existing: { declared: fields, effective: fields, views: [] },
      }),
    );

    expect(model.tree[0]?.detail).toEqual(['Status: Reading', 'Rating: 5']);
  });

  it('carries problems and warnings through unchanged', () => {
    const steps = compileEntries({ entries: [{ title: 'One' }] }, { parentId: null });
    const problems = [{ path: 'entries[0]', code: 'value', message: 'bad' }];
    const warnings = [{ path: 'entries[0]', code: 'hint', message: 'ok' }];
    const model = describeSteps(steps, context({ problems, warnings }));
    expect(model.problems).toBe(problems);
    expect(model.warnings).toBe(warnings);
  });

  it('falls back to a generic per-step description for a mixed plan', () => {
    const steps: Step[] = [
      { kind: 'ensureSandbox' },
      {
        kind: 'setRecurrence',
        target: { itemId: 'i1' },
        rule: { freq: 'daily', interval: 1, weekdays: null, until: null },
      },
    ];
    const model = describeSteps(steps, context());
    expect(model.headline).toBe('I will make 2 changes to Workspace.');
    expect(model.tree).toHaveLength(2);
  });

  it('reports nothing to do for an empty plan', () => {
    const model = describeSteps([], context());
    expect(model.headline).toBe('There is nothing to do.');
    expect(model.tree).toEqual([]);
  });
});

describe('describeStep', () => {
  const property: StructureProperty = {
    key: 'status',
    label: 'Status',
    type: 'select',
    options: ['A', 'B'],
    required: false,
  };
  const view: StructureView = {
    id: 'board',
    name: 'Board',
    kind: 'board',
    columns: ['title', 'status'],
    groupBy: 'status',
    groupOrder: ['A', 'B'],
    dateProperty: null,
    sortBy: null,
    sortDescending: false,
    mode: null,
    coverProperty: null,
    endDateProperty: null,
    cardSize: null,
    layout: null,
    filters: [],
  };

  const fixtures: Record<Step['kind'], Step> = {
    createStructuredItem: {
      kind: 'createStructuredItem',
      parentId: null,
      title: 'Board',
      schema: { properties: [property], inherit: true },
      views: [view],
      defaultViewId: 'board',
    },
    appendViewSetup: {
      kind: 'appendViewSetup',
      itemId: 'item-1',
      properties: [property],
      views: [view],
      makeDefault: false,
    },
    replaceViewSetup: {
      kind: 'replaceViewSetup',
      itemId: 'item-1',
      viewId: 'board',
      schema: { properties: [property], inherit: true },
      originalPropertyKeys: ['status'],
      views: [view],
    },
    createItem: {
      kind: 'createItem',
      parentId: 'item-1',
      title: 'Entry',
      properties: { status: 'A' },
    },
    appendBody: { kind: 'appendBody', target: { itemId: 'item-1' }, markdown: 'Hello' },
    setRecurrence: {
      kind: 'setRecurrence',
      target: { itemId: 'item-1' },
      rule: { freq: 'daily', interval: 1, weekdays: null, until: null },
    },
    setHabit: {
      kind: 'setHabit',
      target: { itemId: 'item-1' },
      settings: { frequency: 'daily', weekdays: null, target: 1, unit: 'time' },
    },
    ensureSandbox: { kind: 'ensureSandbox' },
    captureTemplate: { kind: 'captureTemplate' },
    applyTemplate: { kind: 'applyTemplate' },
  };

  it('describes every step kind', () => {
    for (const kind of STEP_KINDS) {
      const node = describeStep(fixtures[kind], context());
      expect(node.label.length).toBeGreaterThan(0);
    }
  });
});
