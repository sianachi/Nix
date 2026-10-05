import { z } from 'zod';

import { fieldSpecSchema } from './field.js';
import { formSpecSchema } from './form.js';

/** Additive field declarations for an existing item's schema. */
export const fieldsSpecSchema = z
  .object({ fields: z.array(fieldSpecSchema).min(1).max(20) })
  .strict();
export type FieldsSpec = z.infer<typeof fieldsSpecSchema>;

/** A replacement for one existing interactive form, optionally adding fields to its item. */
export const formEditSpecSchema = z
  .object({
    viewId: z.string().min(1).max(128),
    form: formSpecSchema,
    fields: z.array(fieldSpecSchema).max(10).optional(),
  })
  .strict();
export type FormEditSpec = z.infer<typeof formEditSpecSchema>;

/** A new recurrence rule for an existing item. */
export const recurrenceSpecSchema = z
  .object({
    frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
    interval: z.number().int().min(1).max(366),
    weekdays: z.array(z.number().int().min(1).max(7)).max(7).optional(),
    until: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .strict()
  .superRefine((spec, context) => {
    if (spec.weekdays === undefined) return;
    if (new Set(spec.weekdays).size !== spec.weekdays.length) {
      context.addIssue({
        code: 'custom',
        path: ['weekdays'],
        message: 'Weekdays must not contain duplicates.',
      });
    }
  });
export type RecurrenceSpec = z.infer<typeof recurrenceSpecSchema>;
