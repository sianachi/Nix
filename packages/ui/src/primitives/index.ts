/**
 * The primitives layer: frame, typography, icons, and the shared interaction states every
 * higher layer builds its own variants from.
 *
 * This barrel exists so that goals adding to different layers never edit the same file. The root
 * `src/index.ts` re-exports whole layers and changes only when a layer is added, which is rare;
 * a goal adding a control touches `controls/index.ts` and a goal adding a primitive touches this
 * one, so the two can land in either order without a conflict.
 */

export { Blueprint, blueprintFrame, type BlueprintProps } from './Blueprint';
export { Text, type TextProps, type TextVariant, type TextTone, type TextElement } from './Text';
export { Icon, ICON_STROKE_WIDTH, type IconProps, type IconSize } from './Icon';
export { Duotone, type DuotoneProps } from './Duotone';
export {
  accentFillStates,
  accentWashStates,
  disabledState,
  dragHandleLineStates,
  focusRing,
  focusRingInset,
  inkWashStates,
} from './interaction';
