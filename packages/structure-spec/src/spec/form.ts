import { z } from 'zod';

/** One condition gating a form block or page. */
export const condSchema = z
  .object({
    field: z.string().min(1),
    op: z.enum(['equals', 'not_equals', 'contains', 'checked', 'not_checked']),
    value: z.string().max(120).optional(),
  })
  .strict();

export type Cond = z.infer<typeof condSchema>;

const fieldBlockSpecSchema = z
  .object({
    field: z.string().min(1),
    required: z.boolean().optional(),
    help: z.string().max(200).optional(),
    identity: z.enum(['name', 'email']).optional(),
    showWhen: z.array(condSchema).max(4).optional(),
  })
  .strict();

const headingBlockSpecSchema = z
  .object({
    heading: z.string().min(1).max(120),
  })
  .strict();

const paragraphBlockSpecSchema = z
  .object({
    paragraph: z.string().min(1).max(600),
  })
  .strict();

const formBlockSpecSchema = z.union([
  fieldBlockSpecSchema,
  headingBlockSpecSchema,
  paragraphBlockSpecSchema,
]);

const formPageSpecSchema = z
  .object({
    title: z.string().min(1).max(80),
    description: z.string().max(300).optional(),
    showWhen: z.array(condSchema).max(4).optional(),
    blocks: z.array(formBlockSpecSchema).min(1).max(30),
  })
  .strict();

const formTitleSpecSchema = z.union([
  z.object({ from: z.literal('generated') }).strict(),
  z.object({ from: z.literal('field'), field: z.string().min(1) }).strict(),
]);

const formConfirmationSpecSchema = z
  .object({
    title: z.string().min(1).max(80),
    message: z.string().max(300),
  })
  .strict();

/**
 * The shape a pet may propose for an interactive form, before it is compiled into a
 * `StructureForm` (page ids `p1..`, block ids `b1..`, per architecture 2.3). The model never
 * writes those ids itself.
 */
export const formSpecSchema = z
  .object({
    pages: z.array(formPageSpecSchema).min(1).max(10),
    title: formTitleSpecSchema.optional(),
    confirmation: formConfirmationSpecSchema.optional(),
  })
  .strict();

export type FormSpec = z.infer<typeof formSpecSchema>;
