/**
 * The token specimen tables the tokens page renders.
 *
 * Every entry pairs a token name with the literal utility class that consumes
 * it. The classes are written out in full and never assembled from a template
 * string, because Tailwind v4 finds classes by scanning source text - a
 * computed `bg-accent-${step}` would compile to nothing.
 *
 * No value is repeated here: the hex, the px and the shadow definitions live
 * in packages/design-tokens and nowhere else. A specimen shows what a token
 * looks like; it never restates what it is.
 */

export interface Swatch {
  /** Ramp step or role name, as it appears in the token sheet. */
  readonly token: string;
  /** The literal utility class under test. */
  readonly className: string;
}

export const ACCENT_RAMP: readonly Swatch[] = [
  { token: 'accent-100', className: 'bg-accent-100' },
  { token: 'accent-200', className: 'bg-accent-200' },
  { token: 'accent-300', className: 'bg-accent-300' },
  { token: 'accent-400', className: 'bg-accent-400' },
  { token: 'accent-500', className: 'bg-accent-500' },
  { token: 'accent-600', className: 'bg-accent-600' },
  { token: 'accent-700', className: 'bg-accent-700' },
  { token: 'accent-800', className: 'bg-accent-800' },
  { token: 'accent-900', className: 'bg-accent-900' },
];

export const NEUTRAL_RAMP: readonly Swatch[] = [
  { token: 'neutral-100', className: 'bg-neutral-100' },
  { token: 'neutral-200', className: 'bg-neutral-200' },
  { token: 'neutral-300', className: 'bg-neutral-300' },
  { token: 'neutral-400', className: 'bg-neutral-400' },
  { token: 'neutral-500', className: 'bg-neutral-500' },
  { token: 'neutral-600', className: 'bg-neutral-600' },
  { token: 'neutral-700', className: 'bg-neutral-700' },
  { token: 'neutral-800', className: 'bg-neutral-800' },
  { token: 'neutral-900', className: 'bg-neutral-900' },
];

export const ROLE_SWATCHES: readonly Swatch[] = [
  { token: 'background', className: 'bg-background' },
  { token: 'surface', className: 'bg-surface' },
  { token: 'accent', className: 'bg-accent' },
  { token: 'accent-hover', className: 'bg-accent-hover' },
  { token: 'accent-pressed', className: 'bg-accent-pressed' },
  { token: 'foreground', className: 'bg-foreground' },
];

export interface SpacingStep {
  /** Utility suffix, which is also the multiple of the --spacing base. */
  readonly step: string;
  /** Literal width utility, sized off --spacing. */
  readonly className: string;
}

/** The named steps the Industry sheet publishes, as width utilities. */
export const SPACING_STEPS: readonly SpacingStep[] = [
  { step: 'w-1', className: 'w-1' },
  { step: 'w-2', className: 'w-2' },
  { step: 'w-3', className: 'w-3' },
  { step: 'w-4', className: 'w-4' },
  { step: 'w-6', className: 'w-6' },
  { step: 'w-8', className: 'w-8' },
  { step: 'w-16', className: 'w-16' },
  { step: 'w-32', className: 'w-32' },
];

export interface ShapeStep {
  readonly token: string;
  readonly className: string;
}

export const RADIUS_STEPS: readonly ShapeStep[] = [
  { token: 'radius-sm', className: 'rounded-sm' },
  { token: 'radius-md', className: 'rounded-md' },
  { token: 'radius-lg', className: 'rounded-lg' },
];

export const ELEVATION_STEPS: readonly ShapeStep[] = [
  { token: 'shadow-sm', className: 'shadow-sm' },
  { token: 'shadow-md', className: 'shadow-md' },
  { token: 'shadow-lg', className: 'shadow-lg' },
];
