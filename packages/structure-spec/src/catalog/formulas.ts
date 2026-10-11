import { FORMULA_FUNCTION_NAMES } from '@nix/sheet';

export const PROPERTY_FORMULA_GUIDANCE =
  'Formula fields use a bare expression without a leading =. Read exact, case-sensitive property keys as [key], never labels, prop() or PROPERTY(). Declare new formula inputs with explicit keys; read existing keys with nix_read_structure. Use double-quoted text, commas between arguments, = for equality, <> for inequality and AND/OR/NOT for logic. Cells, ranges, JavaScript, TODAY and NOW are unsupported. ' +
  `Supported functions only: ${FORMULA_FUNCTION_NAMES.join(', ')}. ` +
  'Examples: [price] * [quantity]; IF([completion], "Done", "Open"); IFERROR(ROUND([price] * [quantity], 2), 0). DAYS(end, start) subtracts date-only YYYY-MM-DD values; timestamps are unsupported. A formula reads this item; use a rollup to aggregate children. Computed values cannot be assigned.';
