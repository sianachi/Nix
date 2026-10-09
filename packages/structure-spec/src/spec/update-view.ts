import { z } from 'zod';

import { queryOperatorSchema } from './view.js';

const key = z.string().min(1).max(128);
const reference = key.nullable();
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable();
const condition = z
  .object({ property: key, operator: queryOperatorSchema, value: z.string().max(512) })
  .strict();
const filter = z.union([condition, z.object({ any: z.array(condition).min(1).max(8) }).strict()]);

const chartPatch = z
  .object({
    kind: z.enum(['bar', 'column', 'pie', 'line', 'area', 'year']).nullable().optional(),
    period: z.enum(['day', 'week', 'month', 'quarter', 'year']).nullable().optional(),
    splitBy: reference.optional(),
    lastPeriods: z.number().int().min(1).max(371).nullable().optional(),
    from: day.optional(),
    to: day.optional(),
    cumulative: z.boolean().nullable().optional(),
    rollingAverage: z.boolean().nullable().optional(),
    stacked: z.boolean().nullable().optional(),
  })
  .strict()
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: 'A chart patch must change at least one setting.',
  });

/** Narrow stored-view settings; identity, kind, fields, forms and view linkage are immutable. */
export const updateViewSpecSchema = z
  .object({
    viewId: key,
    patch: z
      .object({
        name: z.string().trim().min(1).max(60).optional(),
        columns: z.array(key).max(30).optional(),
        groupBy: reference.optional(),
        groupOrder: z.array(z.string().max(128)).max(64).optional(),
        dateProperty: reference.optional(),
        endDateProperty: reference.optional(),
        sortBy: reference.optional(),
        sortDescending: z.boolean().optional(),
        mode: z.enum(['day', 'week', 'month', 'quarter']).nullable().optional(),
        coverProperty: reference.optional(),
        cardSize: z.enum(['small', 'medium', 'large']).nullable().optional(),
        layout: z.enum(['list', 'grid']).nullable().optional(),
        filters: z.array(filter).max(8).optional(),
        measure: z.enum(['count', 'sum']).nullable().optional(),
        measureProperty: reference.optional(),
        chart: chartPatch.nullable().optional(),
        doneProperty: reference.optional(),
        rowBy: reference.optional(),
      })
      .strict()
      .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
        message: 'A view patch must change at least one setting.',
      }),
  })
  .strict();

export type UpdateViewSpec = z.infer<typeof updateViewSpecSchema>;
export type UpdateViewPatch = UpdateViewSpec['patch'];
