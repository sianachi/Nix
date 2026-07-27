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
 * Grounds: the washes are all built from roles that move with the ground, so
 * they invert correctly without a `dark:` variant. The one exception is
 * `accentFillStates`, which is documented at the bottom of this file.
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

/** Disabled controls: 45% opacity, and a cursor that says "not this one". */
export const disabledState = 'disabled:cursor-not-allowed disabled:opacity-45';

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
 * **Known gap on the dark ground.** These two steps are ramp steps, and the
 * ramps deliberately do not move between grounds - but the label they carry is
 * `--color-background`, which does. On ink the label is dark, so a fill that
 * steps deeper moves *towards* the label: accent-800 under a dark label reads
 * 1.8:1. The rest state is fine (it is a role, 12.1:1 on ink), so this only
 * bites while a pointer is down or over the button, and axe does not reach it -
 * but it is a real defect, not a rounding error.
 *
 * It cannot be fixed here. A fill that carries ground-coloured text has to move
 * *away* from the ground on hover, which is deeper on paper and lighter on ink,
 * and the sheet has no role that does that: `--color-accent-hover` and
 * `--color-accent-pressed` are tuned for text and washes and move one step
 * *towards* the ground from `--color-accent-text` in both. The fix is a
 * `--color-accent-fill{,-hover,-pressed}` triple in the token sheet, which this
 * package does not own. Until then the light ground is correct and the dark one
 * is not, which is stated here rather than papered over with a `dark:` variant.
 */
export const accentFillStates =
  'hover:border-accent-800 hover:bg-accent-800 active:border-accent-900 active:bg-accent-900';
