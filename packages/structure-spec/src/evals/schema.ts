import { z } from 'zod';

const predicateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('view'), viewKind: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('fieldType'), type: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('fieldKey'), key: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('recurrence') }).strict(),
  z.object({ kind: z.literal('habit') }).strict(),
  z.object({ kind: z.literal('inputs') }).strict(),
  z.object({ kind: z.literal('maxDepth'), value: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal('declines') }).strict(),
]);

export type Predicate = z.infer<typeof predicateSchema>;

export const evalExpectationsSchema = z
  .object({
    mustHave: z.array(predicateSchema),
    mustNot: z.array(predicateSchema),
    maxItems: z.number().int().positive(),
    preferComputed: z.array(z.string().min(1)),
  })
  .strict();
export type EvalExpectations = z.infer<typeof evalExpectationsSchema>;

export const consultScenarioSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    problem: z.string().min(1),
    answers: z.array(z.object({ pattern: z.string().min(1), reply: z.string().min(1) }).strict()),
    fallbackReply: z.string().min(1),
    expectations: evalExpectationsSchema,
  })
  .strict()
  .superRefine((scenario, context) => {
    for (const [index, answer] of scenario.answers.entries()) {
      try {
        new RegExp(answer.pattern, 'i');
      } catch {
        context.addIssue({
          code: 'custom',
          path: ['answers', index, 'pattern'],
          message: 'Invalid regular expression.',
        });
      }
    }
  });
export type ConsultScenario = z.infer<typeof consultScenarioSchema>;
