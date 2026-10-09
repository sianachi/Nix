import type { Step } from '../compile/steps.js';
import type { StructureFilterEntry, StructureProperty, StructureView } from '../types.js';
import type { DescribeContext } from './steps.js';
import type { PreviewModel, PreviewNode } from './model.js';

type UpdateStep = Extract<Step, { kind: 'replaceViewSetup' }>;
const labels = {
  name: 'Name',
  columns: 'Columns',
  groupBy: 'Group by',
  groupOrder: 'Group order',
  dateProperty: 'Place by',
  endDateProperty: 'End date',
  sortBy: 'Sort by',
  sortDescending: 'Descending sort',
  sorts: 'Sort order',
  mode: 'Date mode',
  coverProperty: 'Cover',
  cardSize: 'Card size',
  layout: 'Layout',
  filters: 'Filters',
  measure: 'Measure',
  measureProperty: 'Total property',
  doneProperty: 'Completion field',
  rowBy: 'Matrix rows',
} as const;
const references = new Set<string>([
  'groupBy',
  'dateProperty',
  'endDateProperty',
  'sortBy',
  'coverProperty',
  'measureProperty',
  'doneProperty',
  'rowBy',
  'splitBy',
]);
const chartLabels = {
  kind: 'Chart type',
  period: 'Chart period',
  splitBy: 'Chart series',
  lastPeriods: 'Last periods',
  from: 'Chart start',
  to: 'Chart end',
  cumulative: 'Cumulative totals',
  rollingAverage: 'Rolling average',
  stacked: 'Stacked series',
} as const;

function field(key: string, effective: readonly StructureProperty[]): string {
  if (key === 'title') return 'Title';
  if (key === '$type') return 'Kind of item';
  const property = effective.find((candidate) => candidate.key === key);
  return property === undefined ? key : `${property.label} (${key})`;
}

function filters(
  entries: readonly StructureFilterEntry[],
  effective: readonly StructureProperty[],
): string {
  const condition = (entry: Exclude<StructureFilterEntry, { any: unknown }>) =>
    `${field(entry.property, effective)} ${entry.operator}${entry.value.length === 0 ? '' : ` ${entry.value}`}`;
  return entries.length === 0
    ? 'None'
    : entries
        .map((entry) =>
          'any' in entry ? `Any of (${entry.any.map(condition).join(' or ')})` : condition(entry),
        )
        .join(' and ');
}

function setting(key: string, value: unknown, effective: readonly StructureProperty[]): string {
  if (value === null || value === undefined) return 'None';
  if (key === 'filters') return filters(value as StructureFilterEntry[], effective);
  if (key === 'sorts')
    return (value as NonNullable<StructureView['sorts']>).length === 0
      ? 'None'
      : (value as NonNullable<StructureView['sorts']>)
          .map(
            (sort) =>
              `${field(sort.property, effective)} ${sort.descending ? 'descending' : 'ascending'}`,
          )
          .join(', ');
  if (Array.isArray(value))
    return value.length === 0
      ? 'None'
      : value
          .map((entry) => (key === 'columns' ? field(String(entry), effective) : String(entry)))
          .join(', ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string' || typeof value === 'number') {
    return references.has(key) ? field(String(value), effective) : String(value);
  }
  return 'None';
}

/** Every changed setting gets its complete before and after value on the same approval card. */
export function describeUpdateView(step: UpdateStep, context: DescribeContext): PreviewModel {
  const before = context.existing?.views.find((view) => view.id === step.viewId);
  const after = step.views.find((view) => view.id === step.viewId);
  const effective = context.existing?.effective ?? [];
  const changes: PreviewNode[] = [];
  if (before !== undefined && after !== undefined) {
    for (const key of Object.keys(labels) as (keyof typeof labels)[]) {
      if (JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)) {
        changes.push({
          label: labels[key],
          detail: [
            `Before: ${setting(key, before[key], effective)}`,
            `After: ${setting(key, after[key], effective)}`,
          ],
          children: [],
        });
      }
    }
    for (const key of Object.keys(chartLabels) as (keyof typeof chartLabels)[]) {
      if ((before.chart?.[key] ?? null) !== (after.chart?.[key] ?? null)) {
        changes.push({
          label: chartLabels[key],
          detail: [
            `Before: ${setting(key, before.chart?.[key], effective)}`,
            `After: ${setting(key, after.chart?.[key], effective)}`,
          ],
          children: [],
        });
      }
    }
  }
  return {
    headline: `I will update the ${before?.name ?? step.viewId} view on ${context.destination.title}.`,
    destination: context.destination,
    counts: { items: 0, fields: 0, views: 1, entries: 0, writes: 1 },
    tree: [
      { label: `${before?.name ?? step.viewId} (${step.viewId})`, detail: [], children: changes },
    ],
    notes: [],
    warnings: context.warnings,
    problems:
      before === undefined || after === undefined
        ? [
            ...context.problems,
            {
              path: 'viewId',
              code: 'preview-context',
              message:
                'The current and resulting view settings are needed before this change can be approved.',
            },
          ]
        : context.problems,
    neverDoes: [],
  };
}
