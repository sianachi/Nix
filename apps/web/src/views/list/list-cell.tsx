import { useState, type ReactNode } from 'react';

import { PropertyInput } from '../../properties/property-input';
import type { Item, PropertyDefinition, PropertyValue } from '../core/container-model';

/**
 * One editable cell in the list.
 *
 * **The refusal belongs to the cell, not to the table.** A write is refused for one property of one
 * item, and a banner above the table that says so leaves somebody counting rows to find which cell
 * it is about. So the answer to a cell's own edit is held here, beside the control that asked -
 * which is also why the list does not draw the container's `writeError`: the cell has already
 * reported it, and drawing both is two banners for one failure.
 *
 * **Held here rather than in the hook for the same reason.** A refusal in `useContainer` would be
 * state the hook has to decide when to clear, which is server data mirrored into hand-managed
 * state. Here the answer arrives as the return value of the write that caused it, and the next
 * attempt replaces it.
 *
 * The control itself is `PropertyInput`, unchanged in behaviour: it already commits typed values on
 * blur or Enter and discrete ones on the choice, so a cell writes once per completed edit and never
 * once per keystroke.
 */

export interface ListCellProps {
  readonly item: Item;
  readonly property: PropertyDefinition;

  /** Writes the value and answers with the reason it was refused, or null when it was stored. */
  readonly onWrite: (value: PropertyValue) => Promise<string | null>;
}

export function ListCell({ item, property, onWrite }: ListCellProps): ReactNode {
  const [refusal, setRefusal] = useState<string | null>(null);

  return (
    <PropertyInput
      item={item}
      property={property}
      density="cell"
      error={refusal}
      onCommit={(value) => {
        // Cleared before the attempt rather than only replaced after it: leaving the last refusal
        // on screen while the next write is in flight says the new value has already failed.
        setRefusal(null);

        void onWrite(value).then(setRefusal);
      }}
    />
  );
}
