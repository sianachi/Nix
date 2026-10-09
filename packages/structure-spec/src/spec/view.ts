import { z } from 'zod';

import { formSpecSchema } from './form.js';

export const queryOperatorSchema = z.enum([
  'equals',
  'not-equals',
  'on',
  'before',
  'on-or-after',
  'within-next',
  'within-last',
  'contains',
  'not-contains',
  'greater-than',
  'less-than',
  'is-empty',
  'is-not-empty',
]);
export type QueryOperator = z.infer<typeof queryOperatorSchema>;

/**
 * One condition. `field` is a field reference, or one of the structural fields `$type`,
 * `$inside`, `$created`, `$modified`, `$done` a query view may test - passed through unresolved,
 * since they are facts about the item rather than properties.
 *
 * Plain conditions only: a stored view may also hold one level of "any of" groups (Core's
 * `QueryRules`, `StructureFilterGroup` here), but the group shape would push the pet's largest
 * tool schemas past the Codex 4800-byte budget (`catalog/tools.test.ts`), so the pet proposes
 * ANDed conditions and a person adds groups in the editor.
 */
const viewFilterSpecSchema = z
  .object({
    field: z.string().min(1),
    op: queryOperatorSchema,
    value: z.string().max(512),
  })
  .strict();

const VIEW_KINDS = [
  'list',
  'board',
  'calendar',
  'timeline',
  'gallery',
  'sheet',
  'form',
  'interactive_form',
  'query',
  'chart',
  'habit_tracker',
  'checklist',
  'matrix',
  'outline',
] as const;
type ViewKind = (typeof VIEW_KINDS)[number];

/**
 * A field this package's `ViewSpec` allows only on some view kinds, gated by the `superRefine`
 * below rather than by the object schema itself: a Zod object's per-key shape cannot express
 * "this key only when `kind` is one of these" without a discriminated union per kind, which would
 * scatter the same per-kind error message across eleven branches. One table keeps the allowance
 * and the eventual error message next to each other. Typed against `ViewKind` rather than
 * `string` so a missing or misspelled kind fails to compile instead of silently allowing nothing.
 */
const KIND_EXTRA_FIELDS: Record<ViewKind, readonly string[]> = {
  list: ['columns', 'groupBy'],
  sheet: ['columns'],
  form: ['columns'],
  board: ['groupBy', 'groupOrder'],
  chart: ['groupBy', 'groupOrder', 'measure', 'measureField', 'chartKind', 'period', 'splitBy'],
  calendar: ['date', 'endDate', 'mode'],
  timeline: ['date', 'endDate', 'mode'],
  gallery: ['cover', 'cardSize'],
  query: ['preset', 'filters'],
  interactive_form: ['form'],
  habit_tracker: [],
  checklist: ['columns', 'doneProperty'],
  matrix: ['columns', 'rowBy', 'columnBy'],
  outline: [],
};

const ALL_KIND_GATED_FIELDS = [...new Set(Object.values(KIND_EXTRA_FIELDS).flat())] as const;

const CALENDAR_MODES = new Set(['day', 'week', 'month']);
const TIMELINE_MODES = new Set(['week', 'month', 'quarter']);

/**
 * The shape a pet may propose for one view, before it is compiled into a `StructureView`. Every
 * field beyond `kind`, `name`, `sortBy`, `sortDescending`, `default` and `why` belongs to a
 * specific kind (architecture 2.3); the `superRefine` below is the single place that enforces
 * which.
 */
export const viewSpecSchema = z
  .object({
    kind: z.enum(VIEW_KINDS),
    name: z.string().min(1).max(60).optional(),
    columns: z.array(z.string().min(1)).max(30).optional(),
    groupBy: z.string().min(1).describe('See view rules.').optional(),
    groupOrder: z.array(z.string().min(1)).optional(),
    date: z.string().min(1).optional(),
    endDate: z.string().min(1).optional(),
    mode: z.enum(['day', 'week', 'month', 'quarter']).optional(),
    cover: z.string().min(1).optional(),
    cardSize: z.enum(['small', 'medium', 'large']).optional(),
    sortBy: z.string().min(1).optional(),
    sortDescending: z.boolean().optional(),
    preset: z.enum(['today', 'next-seven-days', 'overdue', 'assigned-to-me']).optional(),
    filters: z.array(viewFilterSpecSchema).max(8).optional(),
    measure: z.enum(['count', 'sum']).optional(),
    measureField: z.string().min(1).optional(),
    // Chart only; descriptions left off on purpose, because every byte here is in the pet's tool
    // schema budget and the catalog's chart description already says what they mean.
    chartKind: z.enum(['bar', 'column', 'pie', 'line', 'area', 'year']).optional(),
    period: z.enum(['day', 'week', 'month', 'quarter', 'year']).optional(),
    splitBy: z.string().min(1).optional(),
    form: formSpecSchema.optional(),
    doneProperty: z.string().min(1).optional(),
    rowBy: z.string().min(1).optional(),
    columnBy: z.string().min(1).optional(),
    default: z.boolean().optional(),
    why: z.string().max(200).optional(),
  })
  .strict()
  .superRefine((view, context) => {
    const allowed = new Set(KIND_EXTRA_FIELDS[view.kind]);
    for (const field of ALL_KIND_GATED_FIELDS) {
      const present = (view as Record<string, unknown>)[field] !== undefined;
      if (present && !allowed.has(field)) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} is not valid on a ${view.kind} view.`,
        });
      }
    }

    if (view.mode !== undefined) {
      if (view.kind === 'calendar' && !CALENDAR_MODES.has(view.mode)) {
        context.addIssue({
          code: 'custom',
          path: ['mode'],
          message: 'A calendar mode must be day, week, or month.',
        });
      }
      if (view.kind === 'timeline' && !TIMELINE_MODES.has(view.mode)) {
        context.addIssue({
          code: 'custom',
          path: ['mode'],
          message: 'A timeline mode must be week, month, or quarter.',
        });
      }
    }
  });

export type ViewSpec = z.infer<typeof viewSpecSchema>;
