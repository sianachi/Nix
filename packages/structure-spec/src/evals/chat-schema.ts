import { z } from 'zod';

/** A blueprint node id from the chat fixture (`evals/chat/fixture.json`), resolved to the item
 * the seed built for it. Cases never carry UUIDs: the fixture is rebuilt for every run. */
const nodeRef = z.string().regex(/^[a-z][a-z0-9-]*$/);
const pattern = z.string().min(1);
const jsonValue: z.ZodType = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValue), z.record(z.string(), jsonValue)]),
);

/** One tool operation, or several alternatives joined by `|` ("list_items|search"). */
const operationRef = z.string().regex(/^[a-z_]+(\|[a-z_]+)*$/);

export const chatToolExpectationsSchema = z
  .object({
    /** Each entry must be attempted at least once (any decision), in any order. */
    require: z.array(operationRef).default([]),
    /** These must appear as a subsequence of the attempted operations. */
    inOrder: z.array(operationRef).optional(),
    /** None of these may be attempted. */
    forbid: z.array(operationRef).default([]),
    /** Attempted tool calls above this fail the case, and the run stops there. */
    max: z.number().int().positive().max(12).default(8),
  })
  .strict();

export const chatAssertionSchema = z.discriminatedUnion('kind', [
  /** A child of `parent` whose title matches `title` exists (or not), with these property values. */
  z
    .object({
      kind: z.literal('child'),
      parent: nodeRef,
      title: pattern,
      exists: z.boolean().default(true),
      values: z.record(z.string(), jsonValue).optional(),
    })
    .strict(),
  /** A property of `item` equals `equals`, or is truthy when `truthy` is set. */
  z
    .object({
      kind: z.literal('value'),
      item: nodeRef,
      key: z.string().min(1),
      equals: jsonValue.optional(),
      truthy: z.boolean().optional(),
    })
    .strict(),
  /** The note body of `item` matches (or must not match) `contains`. */
  z
    .object({ kind: z.literal('note'), item: nodeRef, contains: pattern, absent: z.boolean().default(false) })
    .strict(),
  /** `item` declares a field with this key. */
  z.object({ kind: z.literal('field'), item: nodeRef, key: z.string().min(1) }).strict(),
  /** `item` still sits under `parent`. */
  z.object({ kind: z.literal('parent'), item: nodeRef, parent: nodeRef }).strict(),
]);
export type ChatAssertion = z.infer<typeof chatAssertionSchema>;

export const chatCaseSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    /** Sent as the owner's message. `{node:<id>}` is replaced by that fixture item's title. */
    prompt: z.string().min(1),
    tools: chatToolExpectationsSchema.default({ require: [], forbid: [], max: 8 }),
    asserts: z.array(chatAssertionSchema).default([]),
    /** The final reply must match this. */
    answer: pattern.optional(),
    /** The final reply must not match this. */
    answerNot: pattern.optional(),
  })
  .strict()
  .superRefine((item, context) => {
    for (const [key, value] of Object.entries({ answer: item.answer, answerNot: item.answerNot })) {
      if (value === undefined) continue;
      try {
        new RegExp(value, 'i');
      } catch {
        context.addIssue({ code: 'custom', path: [key], message: 'Invalid regular expression.' });
      }
    }
  });
export type ChatCase = z.infer<typeof chatCaseSchema>;
export const chatSuiteSchema = z.array(chatCaseSchema).min(1);
