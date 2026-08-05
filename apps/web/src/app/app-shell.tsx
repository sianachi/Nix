import { Icon, focusRing } from '@nix/ui';
import { PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, Outlet } from 'react-router';

import { useWorkspaceTree } from '../items/use-workspace-tree';
import { WorkspaceSidebar } from '../items/workspace-sidebar';
import { useAnnouncement } from './announcer';
import { usePanes } from '../panes/pane-state';
import { useSelectedItem } from '../routing/selected-item';
import { SearchOverlay } from '../search/search-overlay';
import { useCurrentPrincipal } from '../session/use-current-principal';
import { paneClip } from './layout';
import { ProfileMenu } from './profile-menu';
import { SidebarDivider } from './sidebar-divider';
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
 * scroller. **Vertical belongs to the pane. Horizontal belongs to the view**, because only the view
 * knows what its wide axis is - a board scrolls through columns, a table through property columns,
 * and the pane cannot know which.
 *
 * That division is a convention the views keep, not something the CSS enforces. A pane's
 * `overflow-y-auto` makes it a scroll container on *both* axes - per CSS Overflow 3, one axis
 * leaving `visible` takes the other with it - so what actually keeps the horizontal axis quiet is
 * that every wide view brings its own `overflow-x-auto` and `min-w-0` lets the pane shrink to fit
 * around it. See `paneScroller` in `./layout`.
 *
 * This was previously unimplemented rather than mis-tuned, and it failed in two directions at once.
 * The root was `min-h-dvh`, so `flex-1` never had a definite height and no descendant's
 * `overflow-auto` ever had anything to scroll - every pane grew instead, and the page scrolled.
 * And nothing anywhere clipped: `min-w-0` lets a box shrink but does not stop a descendant painting
 * outside it, so a wide table pushed the *document* into horizontal scroll. Scrolling right then
 * slid the whole page, carrying the fixed sidebar off-screen while view content took the pixels it
 * had been holding - which read as content overflowing into the tree.
 *
 * **No view owns its own vertical axis today, and the one that looks like it does, does not.** The
 * calendar's hour grid carries an `overflow-y-auto` (`calendar-hours.tsx`), but the `Blueprint`
 * above it has no definite height, so the grid's 24 rows size that element instead of scrolling
 * inside it and the pane ends up carrying the whole thing. There are not two vertical scrollers
 * competing - there is one, and it is the pane's. Nothing is unreachable, so this is left alone
 * rather than restructured from the shell; a view that genuinely wants its own vertical axis would
 * need a definite height first, and that is a decision for the view.
 */
export function AppShell(): ReactNode {
  const tree = useWorkspaceTree();
  const principal = useCurrentPrincipal();
  const { selectedId, select } = useSelectedItem();
  const { panes, openBeside, canOpenBeside, besideRefusal } = usePanes();
  const announcement = useAnnouncement();
  const sidebar = useSidebar();
  const [searchOpen, setSearchOpen] = useState(false);

  // The element whose width a drag moves. The divider previews onto it directly - a render per
  // pointer event would re-render the tree and every open editor - and React writes the same
  // number back when the settled value lands in `sidebar.width`.
  const sidebarRef = useRef<HTMLDivElement>(null);

  // A link naming an item the tree has not loaded - which is every link to anything nested, since
  // the tree loads roots and then children on expansion. Without this the screen says "select a
  // note from the tree" about the note it was asked for, which is the worst possible answer to a
  // shared link.
  // Every pane's item, not only the first. Opening a nested note beside another would otherwise
  // land on "that item is not in this workspace" - the tree loads roots and then children on
  // expansion, so anything nested is absent until something asks for it.
  const openIds = panes.map((pane) => pane.itemId).join(' ');
  useEffect(() => {
    if (tree.status !== 'ready') {
      return;
    }

    for (const itemId of openIds.split(' ').filter((id) => id.length > 0)) {
      if (tree.find(itemId) === null) {
        void tree.reveal(itemId);
      }
    }
  }, [openIds, tree]);

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
          skip link at all.

          Every box property is re-applied under `focus:`, which looks redundant and is not:
          `.focus\:not-sr-only:focus` sets `padding: 0` at two-class specificity, so a plain `px-4`
          loses to it and the link paints as bare text in the very corner of the viewport - with the
          top and left of its focus ring outside the window, which is the one thing a focus
          indicator may not be. Offset from the corner and given elevation because it covers the
          header rather than sitting in the layout; `z-50` clears the profile menu at 20 and the
          search overlay at 30, both of which come later in the DOM. */}
      {/* One live region for the whole shell, mounted for the session. The things it reads -
          a pane opened, a pane closed, a control refusing - happen in components that come and go,
          and a region that unmounted with them would take the message with it. Polite, because it
          reports a change the reader asked for rather than interrupting one they did not.

          Never keyed and never conditionally rendered. A live region has to be in the
          accessibility tree before its contents change; one that appears together with its text is
          the canonical reason a region says nothing at all. Saying the same thing twice is handled
          in the announcer, by varying the string rather than the element. */}
      <p aria-live="polite" className="sr-only">
        {announcement.text}
      </p>

      <a
        href="#main"
        className={`sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-surface focus:px-4 focus:py-2 focus:shadow-md ${focusRing}`}
      >
        Skip to content
      </a>

      <header className="flex shrink-0 items-center gap-3 px-4 py-2">
        {/* Next to the tree it opens and closes, rather than inside it - a control that vanishes
            with the thing it controls cannot bring it back. */}
        <button
          type="button"
          aria-label={sidebar.collapsed ? 'Show the workspace tree' : 'Hide the workspace tree'}
          aria-expanded={!sidebar.collapsed}
          onClick={sidebar.toggle}
          className={`flex size-(--control-sm) items-center justify-center rounded-md text-muted hover:bg-foreground/7 hover:text-foreground ${focusRing}`}
        >
          <Icon icon={sidebar.collapsed ? PanelLeftOpen : PanelLeftClose} size="sm" />
        </button>

        <Link
          to="/"
          aria-label="Nix home"
          className={`inline-flex size-(--control-sm) items-center justify-center rounded-md border border-divider font-heading text-xs ${focusRing}`}
        >
          NX
        </Link>

        <button
          type="button"
          onClick={() => {
            setSearchOpen(true);
          }}
          className={`ml-auto flex items-center gap-2 rounded-md bg-surface px-3 py-1.5 text-xs text-muted hover:bg-foreground/7 ${focusRing}`}
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
          <>
            <div
              ref={sidebarRef}
              style={{ width: `${String(sidebar.width)}px` }} // design-token-exempt: the tree's width is a runtime value somebody dragged, not a step on any scale - the same case as a pane's share.
              className="flex shrink-0 overflow-hidden"
            >
              <WorkspaceSidebar
                tree={tree}
                selectedId={selectedId}
                onSelect={select}
                onOpenBeside={openBeside}
                canOpenBeside={canOpenBeside}
                besideRefusal={besideRefusal}
              />
            </div>

            {/* Unmounted with the tree: a handle that resizes something not on screen would be
                a focusable control that visibly does nothing. */}
            <SidebarDivider
              width={sidebar.width}
              onPreview={(width) => {
                sidebarRef.current?.style.setProperty('width', `${String(width)}px`);
              }}
              onCommit={sidebar.resize}
            />
          </>
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
