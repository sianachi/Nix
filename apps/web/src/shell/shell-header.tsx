import { Icon, focusRing } from '@nix/ui';
import { PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react';
import { type ReactNode, type RefObject } from 'react';
import { Link } from 'react-router';

import type { CurrentPrincipalState } from '../session/use-current-principal';
import { WorkspaceSwitcher } from '../workspaces/workspace-switcher';
import { ProfileMenu } from './profile-menu';

export interface ShellHeaderProps {
  readonly sidebarVisible: boolean;
  readonly sidebarToggleRef: RefObject<HTMLButtonElement | null>;
  readonly workspaceId: string;
  readonly principal: CurrentPrincipalState;
  readonly onToggleSidebar: () => void;
  readonly onOpenSearch: () => void;
}

/** The persistent shell controls that remain visible while the workspace tree changes shape. */
export function ShellHeader({
  sidebarVisible,
  sidebarToggleRef,
  workspaceId,
  principal,
  onToggleSidebar,
  onOpenSearch,
}: ShellHeaderProps): ReactNode {
  return (
    <header className="flex min-w-0 shrink-0 items-center gap-1.5 px-2 py-2 sm:gap-3 sm:px-4">
      {/* Next to the tree it opens and closes, rather than inside it - a control that vanishes
          with the thing it controls cannot bring it back. */}
      <button
        ref={sidebarToggleRef}
        type="button"
        aria-label={sidebarVisible ? 'Hide the workspace tree' : 'Show the workspace tree'}
        aria-expanded={sidebarVisible}
        onClick={onToggleSidebar}
        className={`flex size-(--control-sm) items-center justify-center rounded-md text-muted max-sm:min-h-11 max-sm:min-w-11 hover:bg-foreground/7 hover:text-foreground ${focusRing}`}
      >
        <Icon icon={sidebarVisible ? PanelLeftClose : PanelLeftOpen} size="sm" />
      </button>

      <Link
        to={`/w/${workspaceId}`}
        aria-label="Nix home"
        className={`hidden size-(--control-sm) items-center justify-center rounded-md border border-divider font-heading text-xs sm:inline-flex ${focusRing}`}
      >
        NX
      </Link>

      <WorkspaceSwitcher />

      <button
        type="button"
        onClick={onOpenSearch}
        aria-label="Search"
        className={`ml-auto flex shrink-0 max-sm:min-h-11 max-sm:min-w-11 items-center gap-2 rounded-md bg-surface px-2 py-1.5 text-xs text-muted hover:bg-foreground/7 sm:px-3 ${focusRing}`}
      >
        <Icon icon={Search} size="sm" />
        <span className="hidden sm:inline">Search</span>
        {/* The shortcut is shown rather than hidden in a tooltip: a shortcut nobody can discover
            is a shortcut nobody uses. */}
        <kbd className="hidden font-mono text-2xs text-muted md:inline">Ctrl K</kbd>
      </button>

      <ProfileMenu principal={principal} />
    </header>
  );
}
