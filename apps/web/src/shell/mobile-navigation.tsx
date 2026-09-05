import { Icon, Text, focusRing } from '@nix/ui';
import { CalendarDays, FolderTree, Plus, Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router';

export function MobileNavigation({
  workspaceId,
  treeOpen,
  creating,
  onTree,
  onSearch,
  onCreate,
}: {
  readonly workspaceId: string;
  readonly treeOpen: boolean;
  readonly creating: boolean;
  readonly onTree: () => void;
  readonly onSearch: () => void;
  readonly onCreate: () => void;
}): ReactNode {
  const control = `flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-md px-2 py-2 text-muted hover:bg-surface ${focusRing}`;
  return (
    // design-token-exempt: device safe-area inset keeps navigation above the home indicator.
    <nav
      aria-label="Mobile navigation"
      className="flex shrink-0 items-center gap-1 border-t border-divider bg-background px-2 pb-[env(safe-area-inset-bottom)]"
    >
      <button type="button" className={control} aria-expanded={treeOpen} onClick={onTree}>
        <Icon icon={FolderTree} size="sm" />
        <Text variant="caption">Workspace</Text>
      </button>
      <button type="button" className={control} onClick={onSearch}>
        <Icon icon={Search} size="sm" />
        <Text variant="caption">Find</Text>
      </button>
      <NavLink
        to={`/w/${workspaceId}/calendar`}
        className={({ isActive }) => `${control} ${isActive ? 'bg-surface text-foreground' : ''}`}
      >
        <Icon icon={CalendarDays} size="sm" />
        <Text variant="caption">Calendar</Text>
      </NavLink>
      <button
        type="button"
        className={`${control} text-accent`}
        disabled={creating}
        onClick={onCreate}
      >
        <Icon icon={Plus} size="sm" />
        <Text variant="caption">{creating ? 'Creating…' : 'New note'}</Text>
      </button>
    </nav>
  );
}
