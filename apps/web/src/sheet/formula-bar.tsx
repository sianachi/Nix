import { SHEET_LIMITS, type CellRef, cellKey } from '@nix/sheet';
import { cn, fieldLabel, focusRing } from '@nix/ui';
import type { ReactNode } from 'react';

/**
 * The active cell's address and raw text, above the grid.
 *
 * The bar edits the same draft the cell overlay edits: there is one edit in
 * flight, whichever control it is typed into. The address is read-only on
 * purpose - jumping by typing an address is a later refinement, and a field
 * that looks editable but is not would be worse than one that says it is not.
 */

export interface FormulaBarProps {
  readonly active: CellRef;
  /** The text being edited, or the cell's stored raw text outside an edit. */
  readonly text: string;
  readonly editing: boolean;
  readonly onBeginEdit: () => void;
  readonly onChange: (draft: string) => void;
  readonly onCommit: () => void;
  readonly onCancel: () => void;
}

export function FormulaBar(props: FormulaBarProps): ReactNode {
  const { active, text, editing, onBeginEdit, onChange, onCommit, onCancel } = props;

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-divider px-3 py-1.5">
      <output aria-label="Active cell" className={cn('w-16 shrink-0', fieldLabel)}>
        {cellKey(active)}
      </output>

      <input
        aria-label="Formula"
        value={text}
        maxLength={SHEET_LIMITS.maxRawLength}
        onFocus={() => {
          if (!editing) {
            onBeginEdit();
          }
        }}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onCommit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
        placeholder="Type a value, or = to start a formula"
        className={`min-w-0 flex-1 bg-transparent text-sm ${focusRing}`}
      />
    </div>
  );
}
