import { Icon, Text, chromeSurface, cn, focusRing } from '@nix/ui';
import { Bell, CalendarDays, FolderTree, Plus, Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router';

export function MobileNavigation({
  workspaceId,
  treeOpen,
  creating,
  unreadNotifications,
  petAttention,
  onTree,
  onSearch,
  onCreate,
  onOpenInbox,
}: {
  readonly workspaceId: string;
  readonly treeOpen: boolean;
  readonly creating: boolean;
  readonly unreadNotifications: number;
  /** What the pet is waiting on, in words, while its only way in is the drawer this opens. */
  readonly petAttention: string | null;
  readonly onTree: () => void;
  readonly onSearch: () => void;
  readonly onCreate: () => void;
  readonly onOpenInbox: () => void;
}): ReactNode {
  const control = `flex min-h-(--control-lg) min-w-0 flex-1 flex-col items-center justify-center gap-1 sm:flex-row sm:gap-2 rounded-md px-2 py-2 text-muted hover:bg-surface ${focusRing}`;
  return (
    // design-token-exempt: device safe-area inset keeps navigation above the home indicator.
    <nav
      aria-label="Mobile navigation"
      className={`flex shrink-0 items-center gap-1 border-t border-divider bg-background px-2 pb-[env(safe-area-inset-bottom)] ${chromeSurface}`}
    >
      <button type="button" className={control} aria-expanded={treeOpen} onClick={onTree}>
        <span className="relative">
          <Icon icon={FolderTree} size="sm" />
          {petAttention !== null ? (
            <span
              aria-hidden="true"
              className="absolute -right-1 -top-1 size-2 rounded-full bg-accent-fill"
            />
          ) : null}
        </span>
        <Text variant="caption">
          Workspace
          {petAttention !== null ? <span className="sr-only">, pet {petAttention}</span> : null}
        </Text>
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
      <button type="button" className={`relative ${control}`} onClick={onOpenInbox}>
        <span className="relative">
          <Icon icon={Bell} size="sm" />
          {unreadNotifications > 0 ? (
            <span
              aria-hidden="true"
              className="absolute -right-1 -top-1 size-2 rounded-full bg-accent-fill"
            />
          ) : null}
        </span>
        <Text variant="caption">
          Inbox
          {unreadNotifications > 0 ? (
            <span className="sr-only">, {unreadNotifications} unread</span>
          ) : null}
        </Text>
      </button>
      <button
        type="button"
        className={cn(
          control,
          'rounded-md bg-accent-fill text-background hover:bg-accent-fill-hover',
        )}
        disabled={creating}
        onClick={onCreate}
      >
        <Icon icon={Plus} size="sm" className="text-background" />
        <Text variant="caption" className="text-background">
          {creating ? 'Creating…' : 'New note'}
        </Text>
      </button>
    </nav>
  );
}
