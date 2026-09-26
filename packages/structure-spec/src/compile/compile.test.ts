import { describe, expect, it } from 'vitest';

import type { ViewSpec } from '../spec/view.js';
import type { StructureProperty } from '../types.js';
import { compileAddView, compileCreateStructured, compileEntries } from './operations.js';
import { isWriteStep, STEP_KINDS, type Step } from './steps.js';
import { compileView } from './views.js';

const STATUS: StructureProperty = {
  key: 'status',
  label: 'Status',
  type: 'select',
  options: ['To do', 'Doing', 'Done'],
  required: false,
};

describe('compileCreateStructured', () => {
  it('assigns deterministic view ids', () => {
    const steps = compileCreateStructured(
      {
        recipe: 'board',
        fields: [{ label: 'Status', type: 'select', options: ['To do', 'Doing', 'Done'] }],
        views: [
          { kind: 'board', groupBy: 'Status' },
          { kind: 'board', groupBy: 'Status' },
        ],
        inherit: true,
      },
      { parentId: 'parent-1', title: 'Board', inheritedFields: [] },
    );

    const step = steps[0];
    expect(step?.kind).toBe('createStructuredItem');
    if (step?.kind !== 'createStructuredItem') throw new Error('expected createStructuredItem');
    expect(step.views.map((view) => view.id)).toEqual(['board', 'board-2']);
  });

  it('board groupOrder defaults to the select options', () => {
    const steps = compileCreateStructured(
      {
        recipe: 'board',
        fields: [{ label: 'Status', type: 'select', options: ['To do', 'Doing', 'Done'] }],
        views: [{ kind: 'board', groupBy: 'Status' }],
        inherit: true,
      },
      { parentId: null, title: 'Board', inheritedFields: [] },
    );

    const step = steps[0];
    if (step?.kind !== 'createStructuredItem') throw new Error('expected createStructuredItem');
    expect(step.views[0]?.groupOrder).toEqual(['To do', 'Doing', 'Done']);
  });

  it('create_structured with no fields uses the recipe seed', () => {
    const steps = compileCreateStructured(
      { recipe: 'board', fields: [], inherit: true },
      { parentId: null, title: 'Board', inheritedFields: [] },
    );

    const step = steps[0];
    if (step?.kind !== 'createStructuredItem') throw new Error('expected createStructuredItem');
    expect(step.schema.properties.map((property) => property.key)).toEqual(['status']);
    expect(step.views[0]?.kind).toBe('board');
  });

  it('compile is pure: same input, same output', () => {
    const spec = {
      recipe: 'board' as const,
      fields: [{ label: 'Status', type: 'select' as const, options: ['To do', 'Done'] }],
      views: [{ kind: 'board' as const, groupBy: 'Status' }],
      inherit: true,
    };
    const context = { parentId: 'parent-1', title: 'Board', inheritedFields: [] };

    const first = compileCreateStructured(spec, context);
    const second = compileCreateStructured(spec, context);
    expect(second).toEqual(first);
  });
});

describe('compileAddView', () => {
  it('makeDefault is true only when a view asks to be default', () => {
    const steps = compileAddView(
      { views: [{ kind: 'list', default: true }] },
      { itemId: 'item-1', existing: { declared: [STATUS], effective: [STATUS], views: [] } },
    );
    const step = steps[0];
    if (step?.kind !== 'appendViewSetup') throw new Error('expected appendViewSetup');
    expect(step.makeDefault).toBe(true);
  });
});

describe('compileForm (via compileCreateStructured)', () => {
  it('form blocks and pages get sequential ids', () => {
    const steps = compileCreateStructured(
      {
        recipe: 'interactive-form',
        fields: [
          { label: 'Name', type: 'text' },
          { label: 'Email', type: 'text' },
        ],
        views: [
          {
            kind: 'interactive_form',
            form: {
              pages: [
                { title: 'Page one', blocks: [{ field: 'Name' }, { heading: 'Section' }] },
                { title: 'Page two', blocks: [{ field: 'Email' }] },
              ],
            },
          },
        ],
        inherit: true,
      },
      { parentId: null, title: 'Interactive form', inheritedFields: [] },
    );

    const step = steps[0];
    if (step?.kind !== 'createStructuredItem') throw new Error('expected createStructuredItem');
    const form = step.views[0]?.interactiveForm;
    expect(form).toBeTruthy();
    expect(form?.pages.map((page) => page.id)).toEqual(['p1', 'p2']);
    expect(form?.pages.flatMap((page) => page.blocks.map((block) => block.id))).toEqual([
      'b1',
      'b2',
      'b3',
    ]);
  });

  it('conditions reference earlier blocks only', () => {
    expect(() =>
      compileCreateStructured(
        {
          recipe: 'interactive-form',
          fields: [{ label: 'Name', type: 'text' }],
          views: [
            {
              kind: 'interactive_form',
              form: {
                pages: [
                  {
                    title: 'Page one',
                    blocks: [{ field: 'Name', showWhen: [{ field: 'Name', op: 'checked' }] }],
                  },
                ],
              },
            },
          ],
          inherit: true,
        },
        { parentId: null, title: 'Interactive form', inheritedFields: [] },
      ),
    ).toThrow(/no earlier field block/);
  });
});

describe('compileEntries', () => {
  it('entries compile to createItem then appendBody', () => {
    const steps = compileEntries(
      { entries: [{ title: 'First read', markdown: 'Notes here' }] },
      { parentId: 'parent-1' },
    );

    expect(steps.map((step: Step) => step.kind)).toEqual(['createItem', 'appendBody']);
    const [createStep, appendStep] = steps;
    if (createStep?.kind !== 'createItem' || appendStep?.kind !== 'appendBody') {
      throw new Error('expected createItem then appendBody');
    }
    expect(createStep.title).toBe('First read');
    expect(appendStep.target).toEqual({ nodeId: createStep.nodeId });
    expect(appendStep.markdown).toBe('Notes here');
  });

  it('sample entries are prefixed', () => {
    const steps = compileEntries(
      { entries: [{ title: 'Dune', sample: true }] },
      { parentId: 'parent-1' },
    );
    const step = steps[0];
    if (step?.kind !== 'createItem') throw new Error('expected createItem');
    expect(step.title).toBe('Sample: Dune');
  });
});

describe('field reference resolution', () => {
  it('an existing field is matched only by key, never by a stale label', () => {
    expect(() =>
      compileAddView(
        { views: [{ kind: 'board', groupBy: 'Status' }] },
        { itemId: 'item-1', existing: { declared: [STATUS], effective: [STATUS], views: [] } },
      ),
    ).toThrow(/does not resolve/);

    const steps = compileAddView(
      { views: [{ kind: 'board', groupBy: 'status' }] },
      { itemId: 'item-1', existing: { declared: [STATUS], effective: [STATUS], views: [] } },
    );
    const step = steps[0];
    if (step?.kind !== 'appendViewSetup') throw new Error('expected appendViewSetup');
    expect(step.views[0]?.groupBy).toBe('status');
  });

  it('a field added by this same call is matched by its label', () => {
    const steps = compileCreateStructured(
      {
        recipe: 'board',
        fields: [{ label: 'Status', type: 'select', options: ['To do', 'Done'] }],
        views: [{ kind: 'board', groupBy: 'Status' }],
        inherit: true,
      },
      { parentId: null, title: 'Board', inheritedFields: [] },
    );
    const step = steps[0];
    if (step?.kind !== 'createStructuredItem') throw new Error('expected createStructuredItem');
    expect(step.views[0]?.groupBy).toBe('status');
  });

  it('an ambiguous label names both candidates', () => {
    expect(() =>
      compileCreateStructured(
        {
          recipe: 'board',
          fields: [
            { label: 'Owner', type: 'text' },
            { key: 'owner_2', label: 'Owner', type: 'text' },
          ],
          views: [{ kind: 'board', groupBy: 'Owner' }],
          inherit: false,
        },
        { parentId: null, title: 'Board', inheritedFields: [] },
      ),
    ).toThrow(/ambiguous/);
  });
});

describe('inherit: false', () => {
  it('a rollup source does not resolve against the parent when inherit is false', () => {
    expect(() =>
      compileCreateStructured(
        {
          recipe: 'sheet',
          fields: [
            {
              label: 'Count',
              type: 'rollup',
              rollup: { aggregate: 'count', source: 'status' },
            },
          ],
          inherit: false,
        },
        { parentId: null, title: 'Sheet', inheritedFields: [STATUS] },
      ),
    ).toThrow(/does not resolve/);
  });
});

describe('query preset', () => {
  it('a known preset compiles its filters', () => {
    const view = compileView({ kind: 'query', preset: 'today' }, [], new Set());
    expect(view.filters).toEqual([{ property: 'due_date', operator: 'on', value: 'today' }]);
  });

  it('an unknown preset throws rather than compiling an unfiltered view', () => {
    // A preset this build's SMART_LISTS registry does not know - the enum and the registry have
    // drifted apart, which `viewSpecSchema` cannot catch by itself since it only polices the enum.
    const drifted = { kind: 'query', preset: 'nonexistent' } as unknown as ViewSpec;
    expect(() => compileView(drifted, [], new Set())).toThrow(/Unknown query preset/);
  });
});

describe('STEP_KINDS and isWriteStep', () => {
  it('every step kind is a write', () => {
    for (const kind of STEP_KINDS) {
      expect(isWriteStep({ kind } as Step)).toBe(true);
    }
    expect(STEP_KINDS).toContain('ensureSandbox');
    expect(STEP_KINDS).toContain('captureTemplate');
    expect(STEP_KINDS).toContain('applyTemplate');
  });
});
