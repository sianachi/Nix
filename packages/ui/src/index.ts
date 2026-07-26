/**
 * @nix/ui - the Industry design system as React components.
 *
 * Layered: `primitives/` (frame, typography, icons, interaction states) below
 * `controls/` (buttons and, as they land, the rest of the form and navigation
 * set). Higher layers compose lower ones; nothing reaches past a layer to raw
 * markup for something the layer below already provides.
 *
 * The package ships no stylesheet. Consumers own one Tailwind entry that
 * imports the tokens:
 *
 *   @import 'tailwindcss';
 *   @import '@nix/design-tokens';
 *   @source '../../packages/ui/src';
 */

export {
  Blueprint,
  RegistrationMarks,
  blueprintFrame,
  type BlueprintProps,
} from './primitives/Blueprint';
export {
  Text,
  type TextProps,
  type TextVariant,
  type TextTone,
  type TextElement,
} from './primitives/Text';
export { Icon, ICON_STROKE_WIDTH, type IconProps, type IconSize } from './primitives/Icon';
export {
  accentFillStates,
  accentWashStates,
  disabledState,
  focusRing,
  inkWashStates,
} from './primitives/interaction';
export { Button, type ButtonProps, type ButtonVariant } from './controls/Button';
export { cn } from './lib/cn';
