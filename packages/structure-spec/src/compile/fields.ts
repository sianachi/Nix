import type { FieldSpec } from '../spec/field.js';
import { keyFor } from '../spec/keys.js';
import { resolveFieldRef, type ResolvedField } from '../spec/refs.js';
import type { StructureProperty } from '../types.js';
import { describeUnresolvedFieldRef } from './resolve.js';

export interface CompileFieldsScope {
  /** The item's schema before this compilation - what a rollup source or an earlier duplicate key checks against. */
  readonly existing: readonly StructureProperty[];
}

export interface CompiledFields {
  properties: StructureProperty[];
  /** Every compiled field's key, by the label it was given - the same map a preview reads to say "adds Status". */
  keys: Map<string, string>;
}

/**
 * Compiles a list of field specs into properties, in order, resolving each rollup's `source`
 * reference against the fields already on the item and the fields this same call is adding before
 * it (architecture 2.3's `FieldRef` rule; `resolveFieldRef` in `../spec/refs.js`). A formula's
 * `expression` and a rollup's `aggregate` pass straight through: a formula spec is already a bare
 * expression using `[key]` references (architecture 2.3), so there is nothing left to resolve.
 *
 * Callers are expected to compile only specs `@nix/structure-spec/validate` has already accepted
 * (task A.1c), so an unresolvable rollup source here is a caller error, not a user-facing outcome -
 * it throws rather than returning a `Problem`, matching the pure, always-succeeds-on-valid-input
 * shape the rest of this module keeps.
 */
export function compileFields(specs: readonly FieldSpec[], scope: CompileFieldsScope): CompiledFields {
  const properties: StructureProperty[] = [];
  const added: ResolvedField[] = [];
  const keys = new Map<string, string>();

  for (const spec of specs) {
    const key = keyFor(spec);

    const property: StructureProperty = {
      key,
      label: spec.label,
      type: spec.type,
      options: spec.options ?? [],
      required: spec.required ?? false,
      expression: spec.type === 'formula' ? (spec.formula ?? null) : null,
      aggregate: spec.type === 'rollup' ? (spec.rollup?.aggregate ?? null) : null,
      source: null,
    };

    if (spec.type === 'rollup' && spec.rollup?.source !== undefined) {
      const resolution = resolveFieldRef(spec.rollup.source, { existing: scope.existing, added });
      if (!resolution.ok) {
        throw new Error(
          `Field "${spec.label}"'s rollup source: ${describeUnresolvedFieldRef(spec.rollup.source, resolution)}`,
        );
      }
      property.source = resolution.key;
    }

    properties.push(property);
    added.push({ key, label: spec.label });
    keys.set(spec.label, key);
  }

  return { properties, keys };
}
