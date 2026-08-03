/**
 * How a pane's state is named in the address.
 *
 * **The first pane keeps today's parameter names, unprefixed.** `?item=...&view=...&f.status=open`
 * means exactly what it meant before panes existed, so every link anybody has ever been sent still
 * opens the thing it named. Later panes carry a one-based suffix: `item2`, `view2`, `f2.status`.
 * There is no `item1`, and reading one is not an error - it is simply not a name this grammar
 * mints, so it is ignored like any other unrecognised parameter.
 *
 * **A suffix rather than one packed parameter**, for the reason `view-state.ts` already gives for
 * spelling filters `f.<key>=<value>`: somebody can read the link and see what it opens. A nested
 * split encoded into a string would be the opposite, which is also why the grammar has no way to
 * express one - see {@link PANE_LIMIT}.
 *
 * The filter prefix is `f2.` rather than `f.2.` so that the existing scan in `parseFilters` stays
 * a single `startsWith`, and so pane one's filters cannot be confused with a property whose key
 * happens to begin with a digit.
 */

/**
 * How many panes may be open at once.
 *
 * Three. The shell already spends a fixed 264px on the tree and up to 340px on the settings panel;
 * on a 1440px screen a fourth pane leaves each one narrower than the measure `max-w-prose` exists
 * to protect, so the limit is what the layout can honestly show rather than a round number.
 */
export const PANE_LIMIT = 3;

/** Which way the panes are laid out. */
export const SPLIT_PARAM = 'split';

/** The ratio between them, as percentages, one per pane. */
export const SIZES_PARAM = 'sizes';

export type SplitOrientation = 'vertical' | 'horizontal';

/**
 * One orientation for the whole group, not a tree.
 *
 * A nested split needs a structure encoded into the query string, which is the packed-parameter
 * shape this grammar exists to avoid. If nesting is ever wanted it is a different design and a new
 * decision, not a fourth value here.
 */
export const DEFAULT_SPLIT: SplitOrientation = 'vertical';

/**
 * The name a base parameter takes in a given pane.
 *
 * @param base the unprefixed name, as pane one spells it
 * @param index zero-based
 */
export function paneParam(base: string, index: number): string {
  return index === 0 ? base : `${base}${String(index + 1)}`;
}

/** The filter prefix for a pane: `f.` in the first, `f2.` in the second. */
export function paneFilterPrefix(index: number): string {
  return index === 0 ? 'f.' : `f${String(index + 1)}.`;
}

/**
 * Reads the split orientation, falling back rather than failing.
 *
 * A malformed value is a link that drifted, which is worth a line in the console: the alternative
 * is a person reporting that their split link "sometimes" opens the wrong way round.
 */
export function parseSplit(raw: string | null): SplitOrientation {
  if (raw === null || raw.length === 0) {
    return DEFAULT_SPLIT;
  }

  if (raw === 'v' || raw === 'vertical') {
    return 'vertical';
  }

  if (raw === 'h' || raw === 'horizontal') {
    return 'horizontal';
  }

  console.warn(`Ignoring unrecognised "${SPLIT_PARAM}" search parameter:`, raw);
  return DEFAULT_SPLIT;
}

/** What a split orientation is written as. The short form, because a person reads this. */
export function splitToParam(orientation: SplitOrientation): string {
  return orientation === 'horizontal' ? 'h' : 'v';
}

/**
 * Reads the pane ratio, or null to share the space equally.
 *
 * Null rather than a default array because "equal" has to survive a pane being opened or closed:
 * a stored `50,50` would be wrong the moment a third pane appeared, and guessing which two of the
 * three it described is not something a reader of the URL should have to do either.
 *
 * A ratio that does not describe `count` panes is discarded whole. Rescaling a two-pane ratio onto
 * three panes would be inventing a layout nobody chose.
 */
export function parseSizes(raw: string | null, count: number): readonly number[] | null {
  if (raw === null || raw.length === 0) {
    return null;
  }

  const parts = raw.split(',').map((part) => Number(part.trim()));
  if (parts.length !== count || parts.some((part) => !Number.isFinite(part) || part <= 0)) {
    console.warn(`Ignoring unusable "${SIZES_PARAM}" search parameter:`, raw);
    return null;
  }

  return parts;
}

/** Writes a ratio, rounded, because a URL does not need six decimal places of a drag. */
export function sizesToParam(sizes: readonly number[]): string {
  return sizes.map((size) => String(Math.round(size * 10) / 10)).join(',');
}

/**
 * The id a pane's region carries, so focus can be moved to it from outside the pane.
 *
 * A DOM id rather than a ref registry: the two things that need to move focus into a pane are the
 * tree (which opens one) and a sibling pane (which closes itself), and neither is anywhere near
 * the element in the component tree. Threading refs up and back down would be a lot of plumbing
 * for one `focus()`.
 */
export function paneElementId(index: number): string {
  return `nix-pane-${String(index)}`;
}

/**
 * Moves focus into a pane.
 *
 * Deferred a frame, because every caller changes the address first and the element being focused
 * may not exist until React has rendered the arrangement that resulted.
 */
export function focusPane(index: number): void {
  requestAnimationFrame(() => {
    document.getElementById(paneElementId(index))?.focus();
  });
}
