/**
 * Joins class name fragments, dropping anything falsy.
 *
 * Deliberately minimal: this is a scaffold, and the real variant machinery
 * (CVA + tailwind-merge) lives in packages/ui, which owns component variants.
 * Nothing here builds a class name from a runtime value, so there is no
 * conflict for tailwind-merge to resolve.
 */
export function cx(...parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join(' ');
}
