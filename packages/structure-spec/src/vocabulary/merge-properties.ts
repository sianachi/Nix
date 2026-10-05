import type { StructureProperty } from '../types.js';

/**
 * Merges an item's inherited properties with its own declared properties into the effective
 * schema, nearest wins.
 *
 * A property declared closer to the item (in `declared`) replaces an inherited property of the
 * same key in place, so the effective order still runs farther-first; a declared property with no
 * inherited match is appended after. `packages/api-client/src/schemas/templates.ts` keeps its own
 * copy of this same function (api-client cannot depend on sibling packages, and structure-spec
 * cannot depend on api-client's Zod-tied types) - a change to the merge rule here must be made
 * there too; nothing automated compares the two copies, so this is a review-time obligation, not
 * an enforced one. `merge-properties.test.ts` pins this copy's own behaviour; it does not exercise
 * api-client's.
 */
export function mergeProperties(
  inherited: readonly StructureProperty[],
  declared: readonly StructureProperty[],
): StructureProperty[] {
  const replacements = new Map(declared.map((property) => [property.key, property]));
  const inheritedKeys = new Set(inherited.map((property) => property.key));
  return [
    ...inherited.map((property) => replacements.get(property.key) ?? property),
    ...declared.filter((property) => !inheritedKeys.has(property.key)),
  ];
}
