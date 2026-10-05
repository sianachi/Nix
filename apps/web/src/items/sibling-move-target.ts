/**
 * Where an item lands among its own siblings when nudged up or down.
 *
 * A move up does not swap with the sibling above - it lands before it, which is after the sibling
 * two slots up. A move down lands after the very next sibling. Both the mobile move dialog and the
 * desktop tree's keyboard bindings produce this same landing for the same gesture, so the
 * arithmetic lives once here rather than twice with its own comment each time.
 */
export function siblingMoveTarget(
  siblings: readonly { readonly id: string }[],
  index: number,
  direction: 'up' | 'down',
): string | null {
  if (direction === 'up') {
    return siblings[index - 2]?.id ?? null;
  }
  return siblings[index + 1]?.id ?? null;
}
