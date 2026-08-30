import { Icon, Text, focusRing } from '@nix/ui';
import { ChevronDown, LogOut, Settings, User } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';

import { useAuth } from '../auth/auth-provider';
import { ThemeChoice } from '../theme/theme-choice';
import type { CurrentPrincipalState } from '../session/use-current-principal';
import { useWorkspace } from '../workspaces/workspace-context';

/**
 * The profile menu, top right: who you are, and the things that belong to you rather than to the
 * document you are looking at.
 */

export interface ProfileMenuProps {
  readonly principal: CurrentPrincipalState;
}

export function ProfileMenu({ principal }: ProfileMenuProps): ReactNode {
  const { signOut } = useAuth();
  const { workspaceId } = useWorkspace();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    function onPointerDown(event: MouseEvent): void {
      if (containerRef.current?.contains(event.target as Node) === false) {
        setOpen(false);
      }
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        // The innermost layer's Escape wins - see `workspace-sidebar.tsx`'s `CreateMenu` for the
        // full reasoning. This menu is reachable while the drawer (`sidebar-drawer.tsx`) is open,
        // since the header stays interactive by design, so without stopping here Escape would
        // close this menu and the drawer behind it in the same keystroke.
        event.stopPropagation();
        setOpen(false);
      }
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const name = principal.principal?.displayName ?? 'Loading…';

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => {
          setOpen((current) => !current);
        }}
        className={[
          'flex items-center gap-1.5 border border-transparent px-2 py-1',
          'text-xs text-muted',
          `hover:bg-foreground/7 ${focusRing}`,
        ].join(' ')}
      >
        <Icon icon={User} size="sm" />
        <span className="max-w-[16ch] truncate">{name}</span>
        <Icon icon={ChevronDown} size="sm" />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Account"
          className="absolute right-0 z-20 mt-1 w-[240px] border border-divider bg-background shadow-md"
        >
          <div className="border-b border-divider px-3 py-2">
            <Text variant="bodySmall" className="truncate">
              {name}
            </Text>
            {/* Absent rather than blank: a machine identity has no address, and an empty line
                where one should be reads as a bug. */}
            {principal.principal?.email === null ||
            principal.principal?.email === undefined ? null : (
              <Text variant="caption" as="p" tone="muted" className="truncate">
                {principal.principal.email}
              </Text>
            )}
            {principal.status === 'error' ? (
              <Text variant="caption" as="p" tone="muted" role="alert" className="mt-1">
                {principal.error}
              </Text>
            ) : null}
          </div>

          <ThemeChoice />

          {/* Kept here as well as on the nav rail. The rail makes workspace administration
              findable from anywhere; this path keeps personal access tokens beside the identity
              they belong to. A real link, so it can be opened in a new tab and revisited by
              address. */}
          <Link
            role="menuitem"
            to={`/w/${workspaceId}/settings`}
            onClick={() => {
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-base text-foreground no-underline hover:bg-accent/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
          >
            <Icon icon={Settings} size="sm" />
            Settings
          </Link>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void signOut();
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-base text-foreground hover:bg-accent/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
          >
            <Icon icon={LogOut} size="sm" />
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
