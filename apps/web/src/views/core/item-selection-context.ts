import { createContext, useContext } from 'react';

import type { ViewCapabilities } from './view-capabilities';

/**
 * The selection a view's rows and cards take part in, provided by the screen around the view so
 * the selection bar, the context menu's Select entry and a row's checkbox all read one set.
 */
export interface ItemSelectionContextValue {
  readonly selected: ReadonlySet<string>;
  /** Toggles one item; with `shiftKey` extends from the last clicked id across `order`. */
  readonly toggle: (itemId: string, order: readonly string[], shiftKey?: boolean) => void;
  readonly capabilities: ViewCapabilities;
}

export const ItemSelectionContext = createContext<ItemSelectionContextValue | null>(null);

/** Null outside a selecting container, so a view drawn alone (a story, a dialog) offers no boxes. */
export function useOptionalItemSelection(): ItemSelectionContextValue | null {
  return useContext(ItemSelectionContext);
}
