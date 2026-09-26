import { z } from 'zod';
import {
  NODE_ID_PATTERN,
  initRuleSpecSchema,
  templateInputSpecSchema,
} from '../blueprint/schema.js';

const saveRuleSchema = initRuleSpecSchema.safeExtend({
  node: z.union([z.uuid(), z.string().regex(NODE_ID_PATTERN)]),
});

/** Inputs and initialization rules to attach after capturing a workspace subtree. */
export const saveSpecSchema = z
  .object({
    description: z.string().max(400).optional(),
    includeSamples: z.boolean().default(false),
    inputs: z.array(templateInputSpecSchema).max(10).optional(),
    rules: z.array(saveRuleSchema).max(100).optional(),
  })
  .strict();

export type SaveSpec = z.infer<typeof saveSpecSchema>;
