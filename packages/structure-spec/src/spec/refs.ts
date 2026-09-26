import type { StructureProperty } from '../types.js';

/**
 * A field the compiler is about to add, before it has a `StructureProperty`'s full shape - all a
 * `FieldRef` needs to resolve against it is the key it will get and the label it was given.
 */
export interface ResolvedField {
  key: string;
  label: string;
}

export type FieldRefResolution =
  { ok: true; key: string } | { ok: false; code: 'unknown' | 'ambiguous'; candidates: string[] };

/**
 * Resolves a `FieldRef` string against the fields already on the item and the fields a
 * compilation is in the middle of adding (architecture 2.3): an exact key match on either side,
 * or - for a field being added, only - a case-insensitive label match. An existing field's label
 * is never matched: the pet did not choose it, and a stale or renamed label should not silently
 * bind to the wrong property.
 *
 * A ref that matches more than one field, whether by key or by label, is ambiguous rather than
 * resolved to whichever matched first - `candidates` names every key it could mean so the caller
 * can report a precise refusal.
 */
export function resolveFieldRef(
  ref: string,
  scope: { existing: readonly StructureProperty[]; added: readonly ResolvedField[] },
): FieldRefResolution {
  const candidates = new Set<string>();

  for (const existing of scope.existing) {
    if (existing.key === ref) {
      candidates.add(existing.key);
    }
  }
  for (const added of scope.added) {
    if (added.key === ref) {
      candidates.add(added.key);
    }
  }
  for (const added of scope.added) {
    if (added.label.toLowerCase() === ref.toLowerCase()) {
      candidates.add(added.key);
    }
  }

  if (candidates.size === 0) {
    return { ok: false, code: 'unknown', candidates: [] };
  }
  if (candidates.size > 1) {
    return { ok: false, code: 'ambiguous', candidates: [...candidates] };
  }
  for (const key of candidates) {
    return { ok: true, key };
  }
  throw new Error('unreachable: a set of size one always yields one entry');
}
