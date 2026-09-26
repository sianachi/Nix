import { z } from 'zod';

/**
 * The property types a pet may declare, less `assignee`: its values are member UUIDs, and a pet
 * has no way to verify one names a real workspace member. Kept as one literal array, rather than
 * derived from `PROPERTY_TYPES`, so the Zod enum stays a plain tuple; `spec.test.ts` ties the two
 * lists together so a type added to the vocabulary and forgotten here fails a test instead of
 * silently never reaching the pet.
 */
export const FIELD_SPEC_TYPES = [
  'text',
  'number',
  'select',
  'multi_select',
  'date',
  'timestamp',
  'checkbox',
  'url',
  'image',
  'due_date',
  'start_date',
  'completion',
  'priority',
  'estimate',
  'formula',
  'rollup',
] as const;

/**
 * A type whose key is always its own type name (`PropertySchemaRules.cs`'s rule for these five;
 * see `keys.ts`'s `keyFor`, which re-exports this list rather than keeping its own copy). A field
 * spec may still omit `key` for one of these, but it may not declare a different one - that would
 * be silently overridden downstream, which is worse than refusing it here.
 */
export const TASK_SEMANTIC_FIELD_TYPES = [
  'due_date',
  'start_date',
  'completion',
  'priority',
  'estimate',
] as const;

export const ROLLUP_SPEC_AGGREGATES = [
  'count',
  'sum',
  'average',
  'min',
  'max',
  'any',
  'all',
] as const;

/**
 * The shape a pet may propose for one property, before it is compiled into a
 * `StructureProperty`. `label` and `type` are the only fields a request needs; everything else
 * narrows what the type allows, per architecture 2.3.
 */
export const fieldSpecSchema = z
  .object({
    label: z.string().min(1).max(80),
    key: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/)
      .optional(),
    type: z.enum(FIELD_SPEC_TYPES),
    options: z.array(z.string().min(1).max(60)).min(1).max(30).optional(),
    required: z.boolean().optional(),
    formula: z.string().min(1).max(1024).optional(),
    rollup: z
      .object({
        aggregate: z.enum(ROLLUP_SPEC_AGGREGATES),
        source: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    help: z.string().max(200).optional(),
    why: z.string().max(200).optional(),
  })
  .strict()
  .superRefine((field, context) => {
    const taskSemanticType = (TASK_SEMANTIC_FIELD_TYPES as readonly string[]).includes(field.type);
    if (taskSemanticType && field.key !== undefined && field.key !== field.type) {
      context.addIssue({
        code: 'custom',
        path: ['key'],
        message: `A ${field.type} field is always keyed "${field.type}"; omit key or set it to that.`,
      });
    }
    if (
      !taskSemanticType &&
      field.key !== undefined &&
      (TASK_SEMANTIC_FIELD_TYPES as readonly string[]).includes(field.key)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['key'],
        message: `"${field.key}" is reserved for a ${field.key} field.`,
      });
    }

    const takesOptions = field.type === 'select' || field.type === 'multi_select';
    if (takesOptions && field.options === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'Select and multi-select fields need at least one option.',
      });
    }
    if (!takesOptions && field.options !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'Only select and multi-select fields take options.',
      });
    }

    const computed = field.type === 'formula' || field.type === 'rollup';
    if (computed && field.required !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['required'],
        message: 'A computed field cannot be required.',
      });
    }

    if (field.type === 'formula' && field.formula === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['formula'],
        message: 'A formula field needs a formula.',
      });
    }
    if (field.type !== 'formula' && field.formula !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['formula'],
        message: 'Only a formula field takes a formula.',
      });
    }

    if (field.type === 'rollup' && field.rollup === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['rollup'],
        message: 'A rollup field needs a rollup.',
      });
    }
    if (field.type !== 'rollup' && field.rollup !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['rollup'],
        message: 'Only a rollup field takes a rollup.',
      });
    }
  });

export type FieldSpec = z.infer<typeof fieldSpecSchema>;
