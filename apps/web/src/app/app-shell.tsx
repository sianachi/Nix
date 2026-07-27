import { Icon } from '@nix/ui';
import { PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, Outlet } from 'react-router';

import { useWorkspaceTree } from '../items/use-workspace-tree';
import { WorkspaceSidebar } from '../items/workspace-sidebar';
import { useSelectedItem } from '../routing/selected-item';
import { SearchOverlay } from '../search/search-overlay';
import { useCurrentPrincipal } from '../session/use-current-principal';
import { ProfileMenu } from './profile-menu';
import { useSidebar } from './use-sidebar';

/**
 * The application chrome: one workspace, always visible.
 *
 * **There is no tab strip, and that is the point.** Tabs were a faithful reading of the design
 * file's five example screens and the wrong shape for the product: they made a board and a search
 * page into destinations, which they are not. A board is a way of looking at a container, and
 * searching is something you do while reading rather than instead of it. So the shell is a
 * persistent tree beside whatever is open, a search affordance that opens over the top, and a
 * profile menu holding what belongs to the person rather than to the document.
 *
 * The tree lives here rather than on the editor screen because it is how you move around; a tree
 * that appeared on one screen would make every other screen a dead end.
 */
export function AppShell(): ReactNode {
  const tree = useWorkspaceTree();
  const principal = useCurrentPrincipal();
  const { selectedId, select } = useSelectedItem();
  const sidebar = useSidebar();
  const [searchOpen, setSearchOpen] = useState(false);

  // A link naming an item the tree has not loaded - which is every link to anything nested, since
  // the tree loads roots and then children on expansion. Without this the screen says "select a
  // note from the tree" about the note it was asked for, which is the worst possible answer to a
  // shared link.
  useEffect(() => {
    if (selectedId !== null && tree.status === 'ready' && tree.find(selectedId) === null) {
      void tree.reveal(selectedId);
    }
  }, [selectedId, tree]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      // The shortcut everybody already has in their fingers. Both modifiers, because the same
      // browser runs on machines with either.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return (
    <div className="flex min-h-dvh flex-col bg-background font-body text-foreground">
      <header className="flex items-center gap-3 px-[14px] py-2">
        {/* Next to the tree it opens and closes, rather than inside it - a control that vanishes
            with the thing it controls cannot bring it back. */}
        <button
          type="button"
          aria-label={sidebar.collapsed ? 'Show the workspace tree' : 'Hide the workspace tree'}
          aria-expanded={!sidebar.collapsed}
          onClick={sidebar.toggle}
          className="flex size-[26px] items-center justify-center rounded-md text-muted hover:bg-foreground/7 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <Icon icon={sidebar.collapsed ? PanelLeftOpen : PanelLeftClose} size="sm" />
        </button>

        <Link
          to="/"
          aria-label="Nix home"
          className="inline-flex size-[26px] items-center justify-center rounded-md border border-divider font-heading text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          NX
        </Link>

        <span className="text-xs uppercase tracking-[0.1em] text-muted">
          Acme &middot; Engineering
        </span>

        <button
          type="button"
          onClick={() => {
            setSearchOpen(true);
          }}
          className="ml-auto flex items-center gap-2 rounded-md bg-surface px-3 py-1.5 text-xs text-muted hover:bg-foreground/7 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <Icon icon={Search} size="sm" />
          Search
          {/* The shortcut is shown rather than hidden in a tooltip: a shortcut nobody can
              discover is a shortcut nobody uses. */}
          <kbd className="font-mono text-2xs text-muted">Ctrl K</kbd>
        </button>

        <ProfileMenu principal={principal} />
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Unmounted rather than hidden. A tree that is merely off-screen keeps its rows in the
            tab order and in the accessibility tree, so a keyboard would still walk through a
            sidebar nobody can see. */}
        {sidebar.collapsed ? null : (
          <WorkspaceSidebar tree={tree} selectedId={selectedId} onSelect={select} />
        )}

        {/* The shell owns the main landmark so every screen has exactly one, and a screen that
            renders panels side by side does not have to nest them inside another. */}
        <main className="flex min-w-0 flex-1">
          <Outlet context={{ tree, selectedId }} />
        </main>
      </div>

      <SearchOverlay
        open={searchOpen}
        items={tree.items}
        loaded={tree.status === 'ready'}
        onSelect={select}
        onClose={() => {
          setSearchOpen(false);
        }}
      />
    </div>
  );
}

/** What the shell hands to whatever screen is open. */
export interface ShellContext {
  readonly tree: ReturnType<typeof useWorkspaceTree>;
  readonly selectedId: string | null;
}
