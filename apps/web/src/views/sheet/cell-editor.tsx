import { forwardRef } from 'react';
import type { ChangeEvent, FocusEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';

/**
 * The inline-edit overlay shared by the spreadsheet view and the sheet grid: an
 * absolutely positioned input drawn over the active cell. Both callers own their own
 * selection state, commit/cancel logic and focus effect - this component only owns the
 * markup and styling the two had copied verbatim.
 */
export const CELL_EDITOR_CLASSNAME =
  'absolute z-10 bg-background px-2 py-1.5 text-sm outline-2 -outline-offset-2 outline-accent';

export interface CellEditorPosition {
  top: string;
  left: string;
  width: string;
  height: string;
}

export interface CellEditorProps {
  ariaLabel: string;
  value: string;
  position: CellEditorPosition;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  onBlur: (event: FocusEvent<HTMLInputElement>) => void;
  maxLength?: number;
}

export const CellEditor = forwardRef<HTMLInputElement, CellEditorProps>(function CellEditor(
  { ariaLabel, value, position, onChange, onKeyDown, onBlur, maxLength }: CellEditorProps,
  ref,
) {
  return (
    <input
      ref={ref}
      aria-label={ariaLabel}
      value={value}
      maxLength={maxLength}
      onChange={onChange}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      className={CELL_EDITOR_CLASSNAME}
      style={position}
    />
  );
});
