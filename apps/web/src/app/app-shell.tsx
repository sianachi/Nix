import { Icon, focusRing } from '@nix/ui';
import { PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, Outlet } from 'react-router';

import { useWorkspaceTree } from '../items/use-workspace-tree';
import { WorkspaceSidebar } from '../items/workspace-sidebar';
import { useSelectedItem } from '../routing/selected-item';
import { SearchOverlay } from '../search/search-overlay';
import { useCurrentPrincipal } from '../session/use-current-principal';
import { paneClip } from './layout';
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
 *
 * ## The shell owns the viewport
 *
 * Exactly one element is `h-dvh`, exactly one element clips, and each pane owns exactly one
 * scroller on exactly one axis. **Vertical belongs to the pane. Horizontal belongs to the view**,
 * because only the view knows what its wide axis is - a board scrolls through columns, a table
 * through property columns, and the pane cannot know which.
 *
 * This was previously unimplemented rather than mis-tuned, and it failed in two directions at once.
 * The root was `min-h-dvh`, so `flex-1` never had a definite height and no descendant's
 * `overflow-auto` ever had anything to scroll - every pane grew instead, and the page scrolled.
 * And nothing anywhere clipped: `min-w-0` lets a box shrink but does not stop a descendant painting
 * outside it, so a wide table pushed the *document* into horizontal scroll. Scrolling right then
 * slid the whole page, carrying the fixed sidebar off-screen while view content took the pixels it
 * had been holding - which read as content overflowing into the tree.
 *
 * **Not yet settled: a view that wants to own its vertical axis.** The calendar's hour grid is 24
 * rows deep and has an `overflow-y-auto` of its own (`calendar-hours.tsx`), so in week and day
 * modes there are two vertical scrollers in one column and neither owns the axis outright. Making
 * that view's root take a definite height would settle it, but it is a change to how the calendar
 * lays out rather than to the shell, so it is left alone here and named rather than pretended
 * about. No view currently claims its own vertical axis, and the shell does not yet offer a rule
 * for one that wants to.
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
    <div className="flex h-dvh flex-col overflow-hidden bg-background font-body text-foreground">
      {/* First focusable thing in the document, for everybody, on every screen. It used to live in
          a layout element that the route tree had stopped rendering, so in practice the app had no
          skip link at all. */}
      <a
        href="#main"
        className={`sr-only px-4 py-2 focus:not-sr-only focus:absolute focus:bg-background ${focusRing}`}
      >
        Skip to content
      </a>

      <header className="flex shrink-0 items-center gap-3 px-[14px] py-2">
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

      <div className={`flex flex-1 ${paneClip}`}>
        {/* Unmounted rather than hidden. A tree that is merely off-screen keeps its rows in the
            tab order and in the accessibility tree, so a keyboard would still walk through a
            sidebar nobody can see. */}
        {sidebar.collapsed ? null : (
          <WorkspaceSidebar tree={tree} selectedId={selectedId} onSelect={select} />
        )}

        {/* The shell owns the main landmark so every screen has exactly one, and a screen that
            renders panels side by side does not have to nest them inside another. */}
        <main id="main" className={`flex flex-1 ${paneClip}`}>
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
