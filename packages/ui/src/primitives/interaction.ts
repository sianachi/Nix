/**
 * Interaction states, declared once for the whole library.
 *
 * The Industry guide requires themed states everywhere and browser defaults
 * nowhere: a hover tint and a pressed step from the accent ramp, a 2px accent
 * `:focus-visible` outline offset by 2px, and disabled controls at 45%
 * opacity. Controls compose these constants; no component re-declares them,
 * and no usage site overrides them through `className`.
 *
 * Every value below resolves through the design tokens (`--color-accent`, the
 * accent ramp's deep steps, `--color-text`) rather than a literal.
 *
 * Grounds: every state here is built from roles that move with the ground, so
 * they invert correctly without a `dark:` variant anywhere.
 */

/**
 * Keyboard focus. Only `:focus-visible` is styled, so pointer users never see
 * a ring; the UA's own outline is replaced rather than removed, which keeps
 * the control visible in forced-colors mode.
 *
 * The base accent is the ring on both grounds: it is a non-text indicator, so
 * the floor is 3:1, and it reads 3.7:1 on paper and 4.3:1 on ink. A ring that
 * changed step with the ground would be a different ring, and the point of a
 * focus indicator is that it is the same object wherever it lands.
 */
export const focusRing =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

/**
 * `focusRing` for an element inside an `overflow-hidden` clip, where the
 * outward 2px offset would be cut to slivers: the same 2px accent outline,
 * drawn inward instead. Same object, same floor, different side of the edge.
 */
export const focusRingInset =
  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent';

/** Disabled controls: 45% opacity, and a cursor that says "not this one". */
export const disabledState = 'disabled:cursor-not-allowed disabled:opacity-45';

/**
 * The visible line inside a drag handle whose hit strip is wider than its
 * mark: the handle root carries `group` (and `data-dragging` while a drag is
 * live), the line carries these. The base accent as the hover/focus fill is a
 * non-text indicator, so the 3:1 floor from focusRing's note applies; the
 * drag state steps deeper, the same direction a pressed fill moves. The drag
 * state hangs off a data attribute rather than `:active` because a live drag
 * routes the pointer through a capture overlay, which `:active` cannot see.
 *
 * The line itself is a **hairline** - `w-px` or `h-px`, never heavier. The
 * weight is not in this constant, because which axis it applies to differs per
 * handle, but it is part of the same grammar: two handles of different weights
 * on one screen read as two different kinds of object. `<PaneDivider>` and the
 * sheet grid's column handle both draw `w-px`.
 */
export const dragHandleLineStates =
  'group-hover:bg-accent group-focus-visible:bg-accent group-data-[dragging]:bg-accent-pressed';

/**
 * Hover and pressed for a control that sits *on* the ground and tints itself
 * with the accent (ghost buttons, links): a translucent accent wash, so the
 * ground still reads through.
 *
 * The wash is the base accent on both grounds rather than a role, because it
 * is a tint over the ground and not a colour anything is read against - what
 * changes between grounds is the ground showing through it, which is the whole
 * effect. The control's own text keeps its role and its contrast.
 */
export const accentWashStates = 'hover:bg-accent/10 active:bg-accent/18';

/**
 * Hover and pressed for a neutral outlined control (secondary and icon
 * buttons): a wash of `--color-foreground`, which is ink on paper and paper on
 * ink - so the wash lightens on the dark ground without a `dark:` variant.
 */
export const inkWashStates = 'hover:bg-foreground/7 active:bg-foreground/14';

/**
 * Hover and pressed for the one solid accent object. The ramp steps go
 * *deeper* rather than lighter because the fill already carries text: on paper
 * every step has to stay above 4.5:1 against the paper-colored label.
 *
 * See `Button.tsx` for why the rest state is `--color-accent-text` and not the
 * base accent.
 *
 * **Why these are the fill roles and not the text ones.** They start at the same
 * step and move in opposite directions. Accent *text* sits on the ground, so its
 * hover step moves towards the ground. An accent *fill* carries the ground's own
 * colour as its label, so its hover step has to move *away* from the ground -
 * deeper on paper, lighter on ink - or the fill closes on its own label.
 *
 * Written with the text roles, this read 1.8:1 on the dark ground: the ramps do
 * not move between grounds, but `--color-background` does, so a fill stepping
 * deeper moved towards a label that had turned dark. The rest state was fine, so
 * it only bit while a pointer was down or over the button - which is exactly the
 * state axe does not reach.
 */
export const accentFillStates =
  'hover:border-accent-fill-hover hover:bg-accent-fill-hover ' +
  'active:border-accent-fill-pressed active:bg-accent-fill-pressed';

/**
 * The active option of a listbox whose focus lives somewhere else.
 *
 * Its own state rather than a reuse of `accentWashStates`' hover tint, which is what it was. Two
 * things were wrong with borrowing that. The wash is a 10% tint and this is the *only* indication
 * of where the keyboard is - focus never enters the list - so it is a state indicator and owes
 * WCAG 1.4.11's 3:1, which a 10% tint does not come close to. And on anything with a pointer,
 * hover painted the same colour, so "where the keyboard is" and "where the mouse happens to be"
 * became indistinguishable at the moment Enter would commit one of them.
 *
 * A leading accent rule carries the contrast; the wash behind it keeps the row legible as a row.
 * Hover stays at the lighter `inkWashStates` tint in the component, so the two read apart.
 */
export const listboxActiveOption = 'bg-accent/15 shadow-[inset_2px_0_0_0_var(--color-accent)]'; // design-token-exempt: an inset rule is a shadow geometry, not a scale step; the colour it draws is the accent token.

/**
 * A cell inside a grid's range selection.
 *
 * The same argument as {@link listboxActiveOption}, in a grid: the range is what Delete, fill and
 * copy will act on, so its extent is a state indicator owing WCAG 1.4.11's 3:1 - which the 10%
 * wash it used to be carried alone did not approach. The accent perimeter on each cell carries the
 * contrast (adjacent cells' outlines merge into one border around the block); the wash keeps the
 * block reading as one surface. Shared by the spreadsheet body grid and the spreadsheet view so
 * the two cannot drift apart.
 */
export const gridRangeCell = 'bg-accent/10 outline-1 -outline-offset-1 outline-accent';
