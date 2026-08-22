/**
 * A container's property schema — what it declares its children carry — and the effective schema at
 * an item, merged from its ancestors.
 *
 * The schema is the source of truth and the types are `z.infer` of it; the `satisfies` lines tie it
 * to the generated contract. `properties` is the merged effective set (nearest ancestor wins),
 * `declared` is only what this item itself declares, and `inherit` says whether it merges its
 * ancestors' schema in - writing `properties` back rather than `declared` would silently flatten the
 * inheritance, which is why the read keeps them apart.
 */

import { z } from 'zod';
import type { components } from '../generated/api.js';

export const propertyDefinitionSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.string(),
  options: z.array(z.string()),
  required: z.boolean(),

  // For a formula property: the expression evaluated on read. Defaulted rather than merely
  // nullable, so a server from before the field answers schemas this still parses.
  expression: z.string().nullable().default(null),
});

export type PropertyDefinition = z.infer<typeof propertyDefinitionSchema>;

export const effectiveSchemaSchema = z.object({
  properties: z.array(propertyDefinitionSchema),
  declared: z.array(propertyDefinitionSchema),
  inherit: z.boolean(),
});

export type EffectiveSchema = z.infer<typeof effectiveSchemaSchema>;

const _propertyContract = propertyDefinitionSchema satisfies z.ZodType<
  components['schemas']['PropertyDefinitionResponse']
>;
void _propertyContract;

const _effectiveContract = effectiveSchemaSchema satisfies z.ZodType<
  components['schemas']['EffectiveSchemaResponse']
>;
void _effectiveContract;
