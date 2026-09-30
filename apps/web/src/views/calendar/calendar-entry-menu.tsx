import { ContextMenu, type ContextMenuTargetProps, type MenuEntry } from '@nix/ui';
import { CalendarClock } from 'lucide-react';
import type { ReactNode } from 'react';

import { useItemContextActions } from '../core/use-item-context-actions';

/**
 * A calendar entry's secondary-click menu: the actions every view offers on an entry, plus
 * Reschedule - the calendar's own move, which the entry's clock control already reaches - where
 * the calendar can write one.
 */
export function CalendarEntryMenu(props: {
  readonly itemId: string;
  readonly title: string;
  readonly onOpen: (itemId: string) => void;
  readonly onReschedule?: ((itemId: string) => void) | undefined;
  readonly children: (target: ContextMenuTargetProps) => ReactNode;
}): ReactNode {
  const { itemId, title, onOpen, onReschedule, children } = props;
  const itemActions = useItemContextActions(onOpen);

  function items(): MenuEntry[] {
    return itemActions(
      itemId,
      title,
      onReschedule === undefined
        ? []
        : [
            {
              kind: 'action',
              label: 'Reschedule…',
              icon: CalendarClock,
              onSelect: () => {
                onReschedule(itemId);
              },
            },
          ],
    );
  }

  return (
    <ContextMenu label={`${title || 'Untitled'} actions`} items={items}>
      {children}
    </ContextMenu>
  );
}
