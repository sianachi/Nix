import { useCallback, useState } from 'react';

/**
 * Multi-selection over an ordered list of item ids, shared by every view that offers it.
 *
 * Ported from the drive view so list, gallery, board, checklist and the tree select the same way:
 * a plain toggle per item, Shift extends from the last clicked id across the current order, and
 * selecting never opens or drags. The order is passed on each call rather than stored, because a
 * view's order changes with its sort and filters and a stale copy would range over ghosts.
 */
export interface ItemSelection {
  readonly selected: ReadonlySet<string>;
  readonly toggle: (itemId: string, order: readonly string[], shiftKey?: boolean) => void;
  readonly setAll: (ids: readonly string[]) => void;
  readonly clear: () => void;
  /** Drops ids that are no longer in `order`, for after a move or delete. */
  readonly prune: (order: readonly string[]) => void;
}

export function useItemSelection(): ItemSelection {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [lastClicked, setLastClicked] = useState<string | null>(null);

  const toggle = useCallback(
    (itemId: string, order: readonly string[], shiftKey = false): void => {
      setSelected((current) => {
        const next = new Set(current);
        if (shiftKey && lastClicked !== null) {
          const from = order.indexOf(lastClicked);
          const to = order.indexOf(itemId);
          if (from !== -1 && to !== -1) {
            const [start, end] = from < to ? [from, to] : [to, from];
            for (const id of order.slice(start, end + 1)) next.add(id);
            return next;
          }
        }
        if (next.has(itemId)) next.delete(itemId);
        else next.add(itemId);
        return next;
      });
      setLastClicked(itemId);
    },
    [lastClicked],
  );

  const setAll = useCallback((ids: readonly string[]): void => {
    setSelected(new Set(ids));
  }, []);

  const clear = useCallback((): void => {
    setSelected(new Set());
    setLastClicked(null);
  }, []);

  const prune = useCallback((order: readonly string[]): void => {
    setSelected((current) => {
      const keep = new Set(order);
      const next = new Set([...current].filter((id) => keep.has(id)));
      return next.size === current.size ? current : next;
    });
  }, []);

  return { selected, toggle, setAll, clear, prune };
}

/** Whether a pointer event asks to select rather than open: Cmd/Ctrl or Shift held. */
export function isSelectGesture(event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): boolean {
  return event.metaKey || event.ctrlKey || event.shiftKey;
}
