import { describe, expect, it } from 'vitest';

import type { StructureProperty, StructureView } from '../types.js';
import type { ValidationContext } from './report.js';
import { validateSpec } from './spec.js';

function context(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return { inheritedFields: [], today: '2026-09-26', ...overrides };
}

const statusProperty: StructureProperty = {
  key: 'status',
  label: 'Status',
  type: 'select',
  options: ['To do', 'Done'],
  required: false,
};

const dueDateProperty: StructureProperty = {
  key: 'due_date',
  label: 'Due date',
  type: 'due_date',
  options: [],
  required: false,
};

function interactiveFormView(id = 'form'): StructureView {
  return {
    id,
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
              propertyKey: 'status',
              text: 'Status',
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
  };
}

describe('validateSpec create_structured', () => {
  it('accepts a well-formed structured spec', () => {
    const report = validateSpec(
      'create_structured',
      {
        recipe: 'board',
        fields: [{ label: 'Status', type: 'select', options: ['To do', 'Done'] }],
      },
      context(),
    );
    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
    expect(report.stats.fields).toBe(1);
  });

  it('rejects a raw value that fails the Zod shape, with a bracketed path', () => {
    const report = validateSpec(
      'create_structured',
      { recipe: 'board', fields: [{ label: 'Status', type: 'select' }] },
      context(),
    );
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.path === 'fields[0].options')).toBe(true);
  });

  it('refuses an unstorable schema through refuseSchema and names the path', () => {
    const report = validateSpec(
      'create_structured',
      {
        recipe: 'sheet',
        // Both fields are task-semantic and keyed by their type, per `keyFor` - two of them
        // collide on the same key, which `fieldSpecSchema` cannot see (each field is valid on
        // its own) but `refuseSchema` refuses.
        fields: [
          { label: 'Ship by', type: 'due_date' },
          { label: 'Deadline', type: 'due_date' },
        ],
      },
      context(),
    );
    expect(report.ok).toBe(false);
    expect(
      report.problems.some((problem) => problem.path === 'fields' && problem.code === 'schema'),
    ).toBe(true);
  });

  it('refuses a view whose groupBy is not a select', () => {
    const report = validateSpec(
      'create_structured',
      {
        recipe: 'board',
        fields: [{ label: 'Notes', type: 'text' }],
        views: [{ kind: 'board', groupBy: 'notes' }],
      },
      context(),
    );
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.path === 'views[0]')).toBe(true);
  });

  it('reports an unknown form field at its page and block indices', () => {
    const report = validateSpec(
      'create_structured',
      {
        recipe: 'form',
        fields: [{ label: 'Name', type: 'text' }],
        views: [
          {
            kind: 'interactive_form',
            form: {
              pages: [{ title: 'Details', blocks: [{ heading: 'About' }, { field: 'missing' }] }],
            },
          },
        ],
      },
      context(),
    );
    expect(
      report.problems.some((problem) => problem.path === 'views[0].form.pages[0].blocks[1].field'),
    ).toBe(true);
  });

  it('reports a problem for every bad view, not just the first', () => {
    const report = validateSpec(
      'create_structured',
      {
        recipe: 'sheet',
        fields: [{ label: 'Notes', type: 'text' }],
        views: [
          { kind: 'board', groupBy: 'notes' },
          { kind: 'calendar', date: 'notes' },
        ],
      },
      context(),
    );
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.path === 'views[0]')).toBe(true);
    expect(report.problems.some((problem) => problem.path === 'views[1]')).toBe(true);
  });

  it('reports every problem, not only the first', () => {
    const report = validateSpec(
      'create_structured',
      {
        recipe: 'sheet',
        fields: [
          { label: 'Effort', type: 'rollup', rollup: { aggregate: 'sum', source: 'nonexistent' } },
        ],
        views: [{ kind: 'board', groupBy: 'also-nonexistent' }],
      },
      context(),
    );
    expect(report.ok).toBe(false);
    // The unresolved rollup source and the unresolved groupBy are unrelated mistakes; both must
    // be reported, not just whichever one this validator noticed first.
    expect(report.problems.some((problem) => problem.path === 'fields[0].rollup.source')).toBe(
      true,
    );
    expect(report.problems.some((problem) => problem.path === 'views[0].groupBy')).toBe(true);
  });

  it('names both candidates when a ref matches more than one newly added field by label', () => {
    const report = validateSpec(
      'create_structured',
      {
        recipe: 'board',
        fields: [
          { label: 'Owner', key: 'lead', type: 'text' },
          { label: 'Lead', key: 'owner', type: 'text' },
        ],
        views: [{ kind: 'board', groupBy: 'owner' }],
      },
      context(),
    );
    expect(report.ok).toBe(false);
    const problem = report.problems.find((candidate) => candidate.path === 'views[0].groupBy');
    expect(problem?.code).toBe('ambiguous');
    expect(problem?.message).toContain('could mean');
  });

  it('accepts an interactive form with a page condition and a title taken from a field', () => {
    const report = validateSpec(
      'create_structured',
      {
        recipe: 'form',
        fields: [
          { label: 'Name', type: 'text' },
          { label: 'Subscribe', type: 'checkbox' },
        ],
        views: [
          {
            kind: 'interactive_form',
            form: {
              pages: [
                {
                  title: 'Your response',
                  blocks: [{ field: 'name', required: true }, { field: 'subscribe' }],
                },
                {
                  title: 'Thanks for subscribing',
                  showWhen: [{ field: 'subscribe', op: 'checked' }],
                  blocks: [{ heading: 'You are on the list' }],
                },
              ],
              title: { from: 'field', field: 'name' },
            },
          },
        ],
      },
      context(),
    );
    expect(report.ok).toBe(true);
  });

  it('refuses a form condition that references a field not yet declared on an earlier block', () => {
    const report = validateSpec(
      'create_structured',
      {
        recipe: 'form',
        fields: [
          { label: 'Name', type: 'text' },
          { label: 'Subscribe', type: 'checkbox' },
        ],
        views: [
          {
            kind: 'interactive_form',
            form: {
              pages: [
                {
                  title: 'Your response',
                  showWhen: [{ field: 'subscribe', op: 'checked' }],
                  blocks: [{ field: 'name' }, { field: 'subscribe' }],
                },
              ],
            },
          },
        ],
      },
      context(),
    );
    expect(report.ok).toBe(false);
    expect(
      report.problems.some(
        (problem) => problem.path === 'views[0].form.pages[0].showWhen[0].field',
      ),
    ).toBe(true);
  });
});

describe('validateSpec add_view', () => {
  it('refuses a new field whose key already exists in the effective schema', () => {
    const report = validateSpec(
      'add_view',
      {
        fields: [{ label: 'Status again', key: 'status', type: 'text' }],
        views: [{ kind: 'list' }],
      },
      context({ inheritedFields: [statusProperty] }),
    );
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.code === 'collision')).toBe(true);
  });

  it('accepts an additive view over an existing effective schema', () => {
    const report = validateSpec(
      'add_view',
      { views: [{ kind: 'board', groupBy: 'status' }] },
      context({ inheritedFields: [statusProperty] }),
    );
    expect(report.ok).toBe(true);
  });

  it('refuses two newly added fields that collide with each other, not only with an existing one', () => {
    const report = validateSpec(
      'add_view',
      {
        fields: [
          { label: 'Owner', key: 'owner', type: 'text' },
          { label: 'Owner again', key: 'owner', type: 'text' },
        ],
        views: [{ kind: 'list' }],
      },
      context(),
    );
    expect(report.ok).toBe(false);
    const problem = report.problems.find((candidate) => candidate.path === 'fields[1].key');
    expect(problem?.code).toBe('collision');
  });

  it('reports a field collision and a bad view from the same request', () => {
    const report = validateSpec(
      'add_view',
      {
        fields: [{ label: 'Status again', key: 'status', type: 'text' }],
        views: [{ kind: 'board', groupBy: 'nonexistent' }],
      },
      context({ inheritedFields: [statusProperty] }),
    );
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.code === 'collision')).toBe(true);
    expect(
      report.problems.some(
        (problem) => problem.path === 'views[0]' || problem.path === 'views[0].groupBy',
      ),
    ).toBe(true);
  });
});

describe('validateSpec create_entries', () => {
  it('accepts entries whose values fit the effective schema', () => {
    const report = validateSpec(
      'create_entries',
      { entries: [{ title: 'First', values: { status: 'Done' } }] },
      context({ inheritedFields: [statusProperty] }),
    );
    expect(report.ok).toBe(true);
    expect(report.stats.entries).toBe(1);
  });

  it('reports an unknown field name at entries[1].values.rating', () => {
    const report = validateSpec(
      'create_entries',
      {
        entries: [{ title: 'First' }, { title: 'Second', values: { rating: 5 } }],
      },
      context({ inheritedFields: [statusProperty] }),
    );
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.path === 'entries[1].values.rating')).toBe(
      true,
    );
  });

  it('refuses a select value outside its options', () => {
    const report = validateSpec(
      'create_entries',
      { entries: [{ title: 'First', values: { status: 'Archived' } }] },
      context({ inheritedFields: [statusProperty] }),
    );
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.path === 'entries[0].values.status')).toBe(
      true,
    );
  });

  it('reports a bad value in every entry, not only the first', () => {
    const report = validateSpec(
      'create_entries',
      {
        entries: [
          { title: 'First', values: { status: 'Archived' } },
          { title: 'Second', values: { rating: 5 } },
        ],
      },
      context({ inheritedFields: [statusProperty] }),
    );
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.path === 'entries[0].values.status')).toBe(
      true,
    );
    expect(report.problems.some((problem) => problem.path === 'entries[1].values.rating')).toBe(
      true,
    );
  });

  it('refuses a value set on a computed field', () => {
    const total: StructureProperty = {
      key: 'total',
      label: 'Total',
      type: 'formula',
      options: [],
      required: false,
      expression: '1 + 1',
    };
    const report = validateSpec(
      'create_entries',
      { entries: [{ title: 'First', values: { total: 5 } }] },
      context({ inheritedFields: [total] }),
    );
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.path === 'entries[0].values.total')).toBe(
      true,
    );
  });
});

describe('validateSpec apply_template', () => {
  it('accepts an empty inputs object', () => {
    const report = validateSpec('apply_template', {}, context());
    expect(report.ok).toBe(true);
  });
});

describe('validateSpec edit operations', () => {
  it('refuses add_fields that collide with the effective schema', () => {
    const report = validateSpec(
      'add_fields',
      { fields: [{ label: 'Another Status', key: 'status', type: 'text' }] },
      context({ existing: { declared: [statusProperty], views: [] } }),
    );
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.code === 'collision')).toBe(true);
  });

  it('refuses edit_form when the named view is not an interactive form', () => {
    const board = { ...interactiveFormView('board'), kind: 'board', interactiveForm: null };
    const report = validateSpec(
      'edit_form',
      {
        viewId: 'board',
        form: { pages: [{ title: 'Details', blocks: [{ heading: 'Info' }] }] },
      },
      context({ existing: { declared: [], views: [board] } }),
    );
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.path === 'viewId')).toBe(true);
  });

  it('refuses edit_form blocks that name computed fields', () => {
    const total: StructureProperty = {
      key: 'total',
      label: 'Total',
      type: 'formula',
      options: [],
      required: false,
      expression: '1 + 1',
    };
    const report = validateSpec(
      'edit_form',
      {
        viewId: 'form',
        form: { pages: [{ title: 'Details', blocks: [{ field: 'total' }] }] },
      },
      context({
        inheritedFields: [total],
        existing: { declared: [], views: [interactiveFormView()] },
      }),
    );
    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.code === 'views')).toBe(true);
  });

  it('set_recurrence needs an effective due_date field and a value on the item', () => {
    const missingValue = validateSpec(
      'set_recurrence',
      { frequency: 'daily', interval: 1 },
      context({ existing: { declared: [dueDateProperty], views: [] } }),
    );
    expect(missingValue.ok).toBe(false);
    expect(
      missingValue.problems.some((problem) => problem.code === 'recurrence-needs-due-date-value'),
    ).toBe(true);

    const presentValue = validateSpec(
      'set_recurrence',
      { frequency: 'daily', interval: 1 },
      context({
        existing: { declared: [dueDateProperty], views: [] },
        itemValues: { due_date: '2026-10-01' },
      }),
    );
    expect(presentValue.ok).toBe(true);
  });
});
