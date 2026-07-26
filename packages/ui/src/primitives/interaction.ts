/**
 * Interaction states, declared once for the whole library.
 *
 * The Industry guide requires themed states everywhere and browser defaults
 * nowhere: a hover tint and a pressed step from the accent ramp, a 2px accent
 * `:focus-visible` outline offset by 2px, and disabled controls at 45%
 * opacity. Controls compose these constants; no component re-declares them,
 * and no usage site overrides them through `className`.
 *
 * Every value below resolves through the design tokens
 * (`--color-accent`, `--color-accent-600`, `--color-accent-700`,
 * `--color-text`) rather than a literal.
 */

/**
 * Keyboard focus. Only `:focus-visible` is styled, so pointer users never see
 * a ring; the UA's own outline is replaced rather than removed, which keeps
 * the control visible in forced-colors mode.
 */
export const focusRing =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

/** Disabled controls: 45% opacity, and a cursor that says "not this one". */
export const disabledState = 'disabled:cursor-not-allowed disabled:opacity-45';

/**
 * Hover and pressed for a control that sits *on* the light ground and tints
 * itself with the accent (ghost buttons, links): one step past the base, as a
 * translucent accent wash so the ground still reads through.
 */
export const accentWashStates = 'hover:bg-accent/10 active:bg-accent/18';

/**
 * Hover and pressed for a neutral outlined control on the light ground
 * (secondary and icon buttons): an ink wash of the text color.
 */
export const inkWashStates = 'hover:bg-foreground/7 active:bg-foreground/14';

/**
 * Hover and pressed for the one solid accent object. The ramp steps go
 * *deeper* rather than lighter because the fill already carries text: every
 * step has to stay above 4.5:1 against the paper-colored label.
 *
 * See `Button.tsx` for why the rest state is `accent-700` and not the base
 * accent.
 */
export const accentFillStates =
  'hover:border-accent-800 hover:bg-accent-800 active:border-accent-900 active:bg-accent-900';
