import { describe, expect, it } from 'vitest';
import { describeToolCall, type PreviewContext, type PreviewToolArgs } from './preview.js';

function args(overrides: Partial<PreviewToolArgs>): PreviewToolArgs {
  return {
    operation: 'list_items',
    itemId: '',
    parentId: '',
    title: '',
    markdown: '',
    query: '',
    propertiesJson: '',
    specJson: '',
    ...overrides,
  };
}

function context(overrides: Partial<PreviewContext> = {}): PreviewContext {
  return {
    destination: { title: 'Books', path: ['Books'] },
    inheritedFields: [],
    problems: [],
    ...overrides,
  };
}

describe('describeToolCall - legacy operations', () => {
  it('list_items (top level)', () => {
    expect(describeToolCall(args({ operation: 'list_items' }), context()).headline).toBe(
      'I will list the top-level items in this workspace to find what to work on.',
    );
  });

  it('list_items (destination)', () => {
    expect(
      describeToolCall(args({ operation: 'list_items', parentId: 'p1' }), context()).headline,
    ).toBe('I will list the items inside the linked destination to find what to work on.');
  });

  it('search', () => {
    expect(describeToolCall(args({ operation: 'search', query: 'invoices' }), context()).headline).toBe(
      'I will search this workspace for “invoices” to find matching items.',
    );
  });

  it('read_item', () => {
    expect(describeToolCall(args({ operation: 'read_item' }), context()).headline).toBe(
      'I will read the linked item’s details and properties.',
    );
  });

  it('read_note', () => {
    expect(describeToolCall(args({ operation: 'read_note' }), context()).headline).toBe(
      'I will read the linked note’s content for context.',
    );
  });

  it('create_note with content, inside a destination', () => {
    expect(
      describeToolCall(
        args({ operation: 'create_note', title: 'Groceries', parentId: 'p1', markdown: 'Milk' }),
        context(),
      ).headline,
    ).toBe(
      'I will create a note named “Groceries” inside the linked destination, with the content shown below.',
    );
  });

  it('create_note without content, top level', () => {
    expect(
      describeToolCall(args({ operation: 'create_note', title: 'Groceries' }), context()).headline,
    ).toBe('I will create a note named “Groceries” at the top level of this workspace, with an empty body.');
  });

  it('append_note', () => {
    expect(describeToolCall(args({ operation: 'append_note' }), context()).headline).toBe(
      'I will add the content below to the end of the linked note, preserving its existing content.',
    );
  });

  it('rename_item', () => {
    expect(describeToolCall(args({ operation: 'rename_item', title: 'New title' }), context()).headline).toBe(
      'I will rename the linked item to “New title”.',
    );
  });

  it('move_item (destination)', () => {
    expect(
      describeToolCall(args({ operation: 'move_item', parentId: 'p1' }), context()).headline,
    ).toBe('I will move the linked item inside the linked destination.');
  });

  it('move_item (top level)', () => {
    expect(describeToolCall(args({ operation: 'move_item' }), context()).headline).toBe(
      'I will move the linked item to the top level of this workspace.',
    );
  });

  it('set_properties', () => {
    expect(describeToolCall(args({ operation: 'set_properties' }), context()).headline).toBe(
      'I will update the linked item with the property values shown below, leaving other properties unchanged.',
    );
  });

  it('trash_item', () => {
    expect(describeToolCall(args({ operation: 'trash_item' }), context()).headline).toBe(
      'I will move the linked item to Trash. It can be restored later.',
    );
  });

  it('restore_item', () => {
    expect(describeToolCall(args({ operation: 'restore_item' }), context()).headline).toBe(
      'I will restore the linked item from Trash.',
    );
  });

  it('apply_template', () => {
    expect(
      describeToolCall(
        args({ operation: 'apply_template', title: 'Reading log', parentId: 'p1' }),
        context(),
      ).headline,
    ).toBe('I will create “Reading log” from the linked template inside the linked destination.');
  });
});

describe('describeToolCall - new template copy and read_structure', () => {
  it('list_templates', () => {
    expect(describeToolCall(args({ operation: 'list_templates' }), context()).headline).toBe(
      'I will list the templates this workspace can apply.',
    );
  });

  it('read_template', () => {
    expect(describeToolCall(args({ operation: 'read_template' }), context()).headline).toBe(
      'I will read the outline of the linked template.',
    );
  });

  it('read_structure', () => {
    expect(describeToolCall(args({ operation: 'read_structure' }), context()).headline).toBe(
      "I will read the linked item's fields, views and how many children it has.",
    );
  });

  it('apply_template carries the preflight additions and conflicts as notes and a problem', () => {
    const model = describeToolCall(
      args({ operation: 'apply_template', title: 'Reading log' }),
      context({
        preflight: {
          templateId: '11111111-1111-4111-8111-111111111111',
          templateRevision: 1,
          mode: 'create',
          additions: { fields: 2, views: 1, items: 3 },
          conflicts: ['A field named Status already exists'],
          canApply: false,
          initializationPreview: [],
          resolvedInputs: {},
          textBindings: {},
          referenceMappings: {},
        },
      }),
    );
    expect(model.notes).toEqual([
      'Adds 3 items, 2 fields and 1 views.',
      'Conflicts: A field named Status already exists.',
    ]);
    expect(model.problems).toHaveLength(1);
  });
});

describe('describeToolCall - spec operations', () => {
  it('an invalid specJson yields problems and no steps', () => {
    const model = describeToolCall(
      args({ operation: 'create_structured', parentId: 'p1', title: 'Reading log', specJson: 'not json' }),
      context(),
    );
    expect(model.headline).toBe('I cannot run this request as written.');
    expect(model.tree).toEqual([]);
    expect(model.problems.length).toBeGreaterThan(0);
  });

  it('a spec that fails validation yields problems and no steps', () => {
    const model = describeToolCall(
      args({
        operation: 'create_structured',
        parentId: 'p1',
        title: 'Reading log',
        specJson: JSON.stringify({ recipe: 'drive', fields: [], inherit: true }),
      }),
      context(),
    );
    expect(model.headline).toBe('I cannot run this request as written.');
    expect(model.tree).toEqual([]);
    expect(model.problems.length).toBeGreaterThan(0);
  });

  it('compiles and describes a valid create_structured spec, passing model-authored labels through as plain text', () => {
    const model = describeToolCall(
      args({
        operation: 'create_structured',
        parentId: 'p1',
        title: 'Reading log',
        specJson: JSON.stringify({
          recipe: 'board',
          fields: [
            { label: '<b>Status</b>', type: 'select', options: ['To read', 'Reading', 'Done'] },
          ],
          views: [{ kind: 'board', groupBy: '<b>Status</b>' }],
          inherit: true,
        }),
      }),
      context(),
    );
    expect(model.headline).toContain('<b>Status</b>');
    expect(model.problems).toEqual([]);
    expect(model.neverDoes.length).toBeGreaterThan(0);
  });
});
