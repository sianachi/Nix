import { Icon } from '@nix/ui';
import { Search } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, Outlet } from 'react-router';

import { useWorkspaceTree } from '../items/use-workspace-tree';
import { WorkspaceSidebar } from '../items/workspace-sidebar';
import { useSelectedItem } from '../routing/selected-item';
import { SearchOverlay } from '../search/search-overlay';
import { useCurrentPrincipal } from '../session/use-current-principal';
import { ProfileMenu } from './profile-menu';

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
      <header className="flex items-center gap-3 border-b border-divider px-[14px] py-2">
        <Link
          to="/"
          aria-label="Nix home"
          className="inline-flex size-[26px] items-center justify-center border border-divider font-heading text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          NX
        </Link>

        <span className="text-[11px] uppercase tracking-[0.1em] text-foreground/60">
          Acme &middot; Engineering
        </span>

        <button
          type="button"
          onClick={() => {
            setSearchOpen(true);
          }}
          className="ml-auto flex items-center gap-2 border border-divider px-2 py-1 text-[11px] text-foreground/60 hover:bg-foreground/7 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <Icon icon={Search} size="sm" />
          Search
          {/* The shortcut is shown rather than hidden in a tooltip: a shortcut nobody can
              discover is a shortcut nobody uses. */}
          <kbd className="font-mono text-[10px] text-foreground/50">Ctrl K</kbd>
        </button>

        <ProfileMenu principal={principal} />
      </header>

      <div className="flex min-h-0 flex-1">
        <WorkspaceSidebar tree={tree} selectedId={selectedId} onSelect={select} />

        {/* The shell owns the main landmark so every screen has exactly one, and a screen that
            renders panels side by side does not have to nest them inside another. */}
        <main className="flex min-w-0 flex-1">
          <Outlet context={{ tree, selectedId }} />
        </main>
      </div>

      {/* The status strip says what is true right now rather than decorating: the tenant this
          session is pinned to, and the fact that isolation is enforced in the database rather
          than by this application. */}
      <footer className="flex items-center gap-4 border-t border-divider px-[14px] py-1.5 text-[11px] text-foreground/60">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block size-[7px] bg-accent" />
          Single tenant &middot; RLS-isolated
        </span>
        <span className="ml-auto font-mono">{globalThis.location.host}</span>
      </footer>

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
