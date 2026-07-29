/**
 * The shell's layout vocabulary, named once.
 *
 * These are strings rather than components on purpose. The precedent is
 * `packages/ui/src/primitives/interaction.ts`, which does the same for
 * `focusRing` and the wash states: a shared class list is composed at the call
 * site, so a caller can still add to it, and nothing new appears in the DOM or
 * in the accessibility tree. A `<Pane>` component would add a wrapper element
 * to every one of these positions, and the role inventories the view tests
 * assert against would all have to move.
 *
 * Composing them by interpolation is safe for Tailwind's extractor, which
 * matches class names in source text: every utility below appears as a literal
 * in this file, so `paneColumn` interpolating `paneClip` contributes nothing
 * the extractor still needs to find. Compose freely; do not build a class name
 * out of fragments.
 *
 * They live in the app rather than in `packages/ui` because they encode this
 * shell's arrangement - a fixed tree beside a document beside a settings panel -
 * which is not something a design system should know.
 *
 * **Only what more than one file needs is here.** The sidebar's width and the
 * settings panel's width each have exactly one call site and stay in the
 * component that owns them: hoisting them would have `items/` depend on `app/`
 * while `app/` already depends on `items/`, which is a cycle bought for nothing.
 *
 * See the scroll model documented on `AppShell`. In short: one element is
 * `h-dvh`, one clips, and each pane owns one scroller on one axis.
 */

/**
 * A pane that clips its children and shrinks below their content size.
 *
 * `min-h-0` and `min-w-0` are both load-bearing: a flex child's default
 * `min-*: auto` refuses to shrink past its content, which is what pushes a wide
 * table out of its column. `overflow-hidden` is what stops a descendant that is
 * still too wide from painting over its neighbour - shrinking and clipping are
 * different problems and both need saying.
 */
export const paneClip = 'min-h-0 min-w-0 overflow-hidden';

/** A clipping pane that stacks its children and takes the space left over. */
export const paneColumn = `flex flex-1 flex-col ${paneClip}`;

/**
 * The one scroller a pane is allowed, on the one axis a pane may own.
 *
 * Vertical only. The horizontal axis belongs to whichever view is inside,
 * because only the view knows what its wide axis is - columns on a board,
 * properties on a table - and two boxes competing for the same gesture means
 * the outer one wins and the inner one feels broken.
 */
export const paneScrollY = 'min-h-0 min-w-0 flex-1 overflow-y-auto';
