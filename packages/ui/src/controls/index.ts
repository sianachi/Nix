/**
 * The controls layer: things a user operates. Buttons, form controls, tags, cards, navigation,
 * data tables and modals today; the rest of the set as it lands.
 *
 * Controls compose primitives and never reach past them to raw markup for something the layer
 * below already provides. See `primitives/index.ts` for why each layer carries its own barrel.
 */

export { Button, type ButtonProps, type ButtonVariant } from './Button';
export { Card, type CardProps } from './Card';
export { Dialog, type DialogProps } from './Dialog';
export { Field, type FieldControlProps, type FieldProps } from './Field';
export { Input, type InputProps, type InputTone } from './Input';
export { Segmented, type SegmentedOption, type SegmentedProps } from './Segmented';
export { Select, type SelectProps } from './Select';
export {
  Nav,
  type NavItem,
  type NavLinkRenderProps,
  type NavOrientation,
  type NavProps,
} from './Nav';
export {
  Table,
  type TableColumn,
  type TableProps,
  type TableSort,
  type TableSortDirection,
} from './Table';
export { Tag, type TagProps, type TagTone } from './Tag';
export { Tabs, type TabItem, type TabsOrientation, type TabsProps } from './Tabs';
