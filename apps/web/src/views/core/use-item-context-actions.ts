import type { MenuEntry } from '@nix/ui';
import { Eye, EyeOff, FileText } from 'lucide-react';

import { useAutomateEntry } from '../../automations/automate-entry';
import { bookmarkEntry, copyLinkEntry } from '../../items/item-menu-entries';
import { useMuteRemindersEntry } from '../../settings/mute-reminders-entry';
import { useOptionalWorkspace } from '../../workspaces/workspace-context';
import { useHiddenItems } from '../../items/use-hidden-items';

/**
 * The secondary-click actions every view offers on an entry - a list row, a board or gallery card,
 * a calendar entry: Open, then any the view adds of its own, then the ones that mean the same
 * thing everywhere. Deliberately a builder called when a menu opens, so nothing here subscribes a
 * row to state it only needs at that moment.
 */
export function useItemContextActions(
  onOpen: (itemId: string) => void,
): (itemId: string, title: string, extra?: readonly MenuEntry[]) => MenuEntry[] {
  const workspace = useOptionalWorkspace();
  const automateEntry = useAutomateEntry(workspace?.workspaceId ?? null);
  const muteRemindersEntry = useMuteRemindersEntry();
  const visibility = useHiddenItems();

  return (itemId, title, extra = []) => [
    {
      kind: 'action',
      label: 'Open',
      icon: FileText,
      onSelect: () => {
        onOpen(itemId);
      },
    },
    ...extra,
    ...(!visibility.enabled
      ? []
      : [
          {
            kind: 'action' as const,
            label: visibility.hiddenSet.has(itemId) ? 'Show for me' : 'Hide for me',
            icon: visibility.hiddenSet.has(itemId) ? Eye : EyeOff,
            onSelect: () => {
              if (visibility.hiddenSet.has(itemId)) visibility.show(itemId, title);
              else visibility.hide(itemId, title);
            },
          },
        ]),
    bookmarkEntry(itemId),
    ...(workspace === null ? [] : [copyLinkEntry(workspace.workspaceId, itemId, title)]),
    ...(automateEntry === null ? [] : [automateEntry(itemId)]),
    ...(muteRemindersEntry === null ? [] : [muteRemindersEntry(itemId, title)]),
  ];
}
