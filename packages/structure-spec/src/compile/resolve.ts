import { resolveFieldRef, type FieldRefResolution } from '../spec/refs.js';
import type { StructureProperty } from '../types.js';

/**
 * A field reference's failure, worded so the difference between "no field named this" and "more
 * than one field could be meant" is visible in the thrown message - `resolveFieldRef`
 * (`../spec/refs.js`) already tells the two apart in its return value, and swallowing that
 * distinction in a single generic message would make an ambiguous rollup source or view column
 * look identical to a typo.
 */
export function describeUnresolvedFieldRef(
  ref: string,
  resolution: FieldRefResolution & { ok: false },
): string {
  if (resolution.code === 'ambiguous') {
    return `Field reference "${ref}" is ambiguous: it could mean ${resolution.candidates.join(' or ')}.`;
  }
  return `Field reference "${ref}" does not resolve to a known field.`;
}

/**
 * Resolves a `FieldRef` against the schema a view or a form sees, honouring architecture 2.3's
 * rule that an existing field's label is never matched (`../spec/refs.js`'s own doc comment):
 * only the keys in `addedKeys` are label-searchable, and every key in `effective` - added or not -
 * is exact-match searchable. `addedKeys` is optional so a caller compiling a view or a form outside
 * an operation's own field-compilation step (a direct unit test, for instance) can still resolve by
 * label against everything it is given; every production caller in `operations.ts` passes it.
 */
export function resolveKey(
  ref: string,
  effective: readonly StructureProperty[],
  addedKeys?: ReadonlySet<string>,
): string {
  const isAdded = (property: StructureProperty): boolean =>
    addedKeys === undefined || addedKeys.has(property.key);

  const scope = {
    existing: effective.filter((property) => !isAdded(property)),
    added: effective.filter(isAdded).map((property) => ({ key: property.key, label: property.label })),
  };

  const resolution = resolveFieldRef(ref, scope);
  if (!resolution.ok) {
    throw new Error(describeUnresolvedFieldRef(ref, resolution));
  }
  return resolution.key;
}
