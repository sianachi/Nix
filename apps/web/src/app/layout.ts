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
 * A pane's scroller.
 *
 * `overflow-y-auto` states the intent - the pane exists to scroll vertically -
 * but it is worth knowing that CSS does not honour it as a restriction. Per CSS
 * Overflow 3, when one axis is not `visible` the other's `visible` computes to
 * `auto`, so this element is a scroll container on *both* axes and
 * `overflow-y-auto` and `overflow-auto` compute identically. Verified in a
 * browser, not assumed.
 *
 * What actually keeps the horizontal axis out of the pane's hands is the view
 * inside it: `min-w-0` lets the pane shrink to the space available, and every
 * view wide enough to need it carries its own `overflow-x-auto`, which
 * constrains its content to the pane's width so the pane's own horizontal
 * scroller never has anything to scroll. A wide view that does *not* bring one
 * falls back to this - which is the degraded case, not the design.
 */
export const paneScroller = 'min-h-0 min-w-0 flex-1 overflow-y-auto';
