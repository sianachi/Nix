import { describe, expect, it } from 'vitest';
import { containerViewConfigurationsSchema, viewConfigurationSchema } from './views.js';

describe('full stored view configuration reads', () => {
  it('preserves arrangement, filters, checklist, matrix, and chart options', () => {
    const view = viewConfigurationSchema.parse({
      id: 'chart',
      name: 'Weekly effort',
      kind: 'chart',
      columns: ['status', 'effort'],
      groupBy: 'due',
      groupOrder: ['Ready', 'Done'],
      filters: [
        {
          property: null,
          operator: null,
          value: null,
          any: [
            { property: 'status', operator: 'equals', value: 'Ready' },
            { property: 'status', operator: 'is-empty', value: null },
          ],
        },
      ],
      sorts: [
        { property: 'due', descending: false },
        { property: 'effort', descending: true },
      ],
      collapsedGroups: ['Done'],
      groupLimits: [{ group: 'Ready', limit: '4' }],
      aggregates: [{ property: 'effort', function: 'sum' }],
      doneProperty: 'finished',
      rowBy: 'priority',
      measure: 'sum',
      measureProperty: 'effort',
      companionViewId: 'list',
      companionPlacement: 'beside',
      chart: {
        kind: 'line',
        period: 'week',
        splitBy: 'status',
        lastPeriods: 8,
        cumulative: true,
        rollingAverage: false,
        stacked: false,
      },
    });
    expect(view).toMatchObject({
      filters: [
        {
          any: [
            { property: 'status', value: 'Ready' },
            { operator: 'is-empty', value: null },
          ],
        },
      ],
      sorts: [{ property: 'due' }, { property: 'effort' }],
      groupLimits: [{ limit: '4' }],
      aggregates: [{ function: 'sum' }],
      doneProperty: 'finished',
      rowBy: 'priority',
      measureProperty: 'effort',
      companionViewId: 'list',
      chart: { kind: 'line', period: 'week', cumulative: true, from: null },
    });
  });

  it('preserves conditional form pages, field conditions and confirmation behavior', () => {
    const view = viewConfigurationSchema.parse({
      id: 'intake',
      name: 'Intake',
      kind: 'interactive_form',
      interactiveForm: {
        pages: [
          {
            id: 'p1',
            title: 'Details',
            description: null,
            visibleWhen: [{ fieldBlockId: 'category', operator: 'equals', value: 'Work' }],
            blocks: [
              {
                id: 'due',
                kind: 'field',
                propertyKey: 'due',
                text: '',
                help: 'When?',
                required: true,
                identityRole: null,
                visibleWhen: [{ fieldBlockId: 'category', operator: 'is-not-empty', value: null }],
              },
            ],
          },
        ],
        titleMode: 'field',
        titleFieldBlockId: 'due',
        confirmationTitle: 'Saved',
        confirmationMessage: 'You can close this form.',
      },
    });
    expect(view.interactiveForm?.pages[0]?.visibleWhen[0]?.value).toBe('Work');
    expect(view.interactiveForm?.pages[0]?.blocks[0]).toMatchObject({
      help: 'When?',
      required: true,
      visibleWhen: [{ operator: 'is-not-empty' }],
    });
    expect(view.interactiveForm?.confirmationTitle).toBe('Saved');
  });

  it('keeps Core renderability/default decisions and supplies legacy optional defaults', () => {
    const result = containerViewConfigurationsSchema.parse({
      views: [{ id: 'calendar', name: 'Schedule', kind: 'calendar', dateProperty: 'removed' }],
      unrenderable: ['calendar'],
      default: 'calendar',
      hideDocument: true,
    });
    expect(result.unrenderable).toEqual(['calendar']);
    expect(result.views[0]).toMatchObject({ columns: [], filters: [], sorts: [], chart: null });
    expect(result.hideDocument).toBe(true);
  });

  it('rejects malformed configuration rather than silently dropping the field', () => {
    expect(
      viewConfigurationSchema.safeParse({
        id: 'list',
        name: 'List',
        kind: 'list',
        filters: [{ property: 'status', operator: 7, value: 'Done' }],
      }).success,
    ).toBe(false);
    expect(
      viewConfigurationSchema.safeParse({
        id: 'chart',
        name: 'Chart',
        kind: 'chart',
        chart: { lastPeriods: 'nonsense' },
      }).success,
    ).toBe(false);
  });
});
