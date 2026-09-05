import { useBackDismiss } from '../layout/use-back-dismiss';
import { ItemDialogProvider } from '../items/item-dialog-provider';
import { MobileNavigation } from './mobile-navigation';
import { PwaControls } from '../pwa/pwa-controls';
import { useRememberLocation } from '../pwa/use-remember-location';
import { focusRing } from '@nix/ui';
import { useRef, useState, type ReactNode } from 'react';
import { Outlet, useNavigate } from 'react-router';

import { useAuth } from '../auth/auth-provider';
import { ImportDialog } from '../import/import-dialog';
import { useWorkspaceTree, type TreeItem } from '../items/use-workspace-tree';
import { announce, useAnnouncement } from '../a11y/announcer';
import type { ShellContext } from './shell-context';
import { focusPane } from '../panes/pane-params';
import { usePanes } from '../panes/pane-state';
import { useSelectedItem } from '../routing/selected-item';
import { CommandPalette } from '../search/command-palette';
import { builtInCommands } from '../search/commands';
import { useBookmarksLoader, useBookmarksStore, useIsKept } from '../bookmarks/use-bookmarks';
import { useOpenItem } from '../tabs/use-open-item';
import { useCurrentPrincipal } from '../session/use-current-principal';
import { paneClip } from '../layout/regions';
import { NavRail } from './nav-rail';
import { useNarrowViewport } from '../layout/viewport';
import { useSidebar } from '../layout/use-sidebar';
import type { StructuredRecipeId } from '../views/wizard/structured-recipes';
import { useTemplates } from '../templates/use-templates';
import { TemplateLibraryProvider } from '../templates/template-library-context';
import { ShellHeader } from './shell-header';
import { useRevealOpenPanes, useShellSearchShortcut } from './shell-effects';
import { ShellSidebar } from './shell-sidebar';
import { ShellToasts, useShellToasts } from './shell-toasts';
import { useWorkspace } from '../workspaces/workspace-context';
import { WorkspaceInvitationNotice } from '../workspaces/workspace-invitation-notice';

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
 * around it. See `paneScroller` in `../layout/regions`.
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
  const navigate = useNavigate();
  const { workspaceId } = useWorkspace();
  useRememberLocation(workspaceId);
  const [creating, setCreating] = useState(false);
  const { getAccessToken } = useAuth();
  const tree = useWorkspaceTree();
  const principal = useCurrentPrincipal();
  const { selectedId } = useSelectedItem();
  const { panes } = usePanes();
  const { openPreview, openPinned, openBeside, canOpenBeside, besideRefusal } = useOpenItem();
  const announcement = useAnnouncement();
  const narrow = useNarrowViewport();
  const templateLibrary = useTemplates();

  // The shelf is loaded once, here, because four places read it at the same time - this page's
  // rail, the tree's rows, the open document's control and the palette. See use-bookmarks.ts.
  useBookmarksLoader();
  const toggleBookmark = useBookmarksStore((state) => state.toggle);
  const selectedIsKept = useIsKept(selectedId);
  const sidebar = useSidebar(narrow);
  const [searchOpen, setSearchOpen] = useState(false);
  const [workspaceImportOpen, setWorkspaceImportOpen] = useState(false);
  useBackDismiss(narrow && (sidebar.visible || searchOpen || workspaceImportOpen), () => {
    setWorkspaceImportOpen(false);
    setSearchOpen(false);
    if (sidebar.visible) sidebar.toggle();
  });

  // What Escape and a scrim tap - the two "never mind" exits from the drawer - focus afterwards.
  // Unlike `closeDrawerAfter` above, these are not "there, that one": nothing was chosen, so focus
  // belongs on the control that reopens the drawer, the same place it already was before the
  // drawer took it.
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);

  function startStructured(parentId: string | null, recipe: StructuredRecipeId): void {
    const search = parentId === null ? '' : `?parent=${encodeURIComponent(parentId)}`;
    void navigate(`/w/${workspaceId}/new/${recipe}${search}`);
    if (narrow && sidebar.visible) {
      sidebar.toggle();
    }
  }

  function startTemplate(parentId: string | null, templateId: string): void {
    const search = parentId === null ? '' : `?parent=${encodeURIComponent(parentId)}`;
    void navigate(`/w/${workspaceId}/templates/${templateId}/create${search}`);
    if (narrow && sidebar.visible) sidebar.toggle();
  }

  function browseTemplates(parentId: string | null): void {
    const search = parentId === null ? '' : `?parent=${encodeURIComponent(parentId)}`;
    void navigate(`/w/${workspaceId}/templates${search}`);
    if (narrow && sidebar.visible) sidebar.toggle();
  }

  // Where focus goes once a delete toast's undo window closes, by any path. The row that opened it
  // is gone by then - deleted, which is why there is a toast at all - so there is no invoker to
  // return focus to the way `<Dialog>` does; the tree's own scroll region, inside
  // `<WorkspaceSidebar>`, is the nearest thing that is still guaranteed to be there. Owned here
  // rather than by the sidebar because the toast that reads it is rendered here too - see the
  // toast state below for why.
  const treeRegionRef = useRef<HTMLDivElement>(null);

  const shellToasts = useShellToasts();

  /**
   * Deletes at once and reports it, rather than asking first: the interface used to gate this
   * behind `globalThis.confirm()`, on the reasoning that deletion read as permanent with no way
   * back. `tree.restore` already existed and had no caller - the honest fix was to give deletion
   * an undo instead of a better-looking confirmation, which is what the toast below is for.
   *
   * **Awaits `tree.remove` before claiming anything happened.** A toast that appeared the instant
   * the request was sent, rather than once it actually succeeded, would assert a past-tense fact
   * ("Deleted") before it was one - and on a failure would go on asserting it while the item sat
   * unchanged in the tree, its real error rendered at the sidebar's foot, underneath the toast that
   * was lying about it. No toast at all is the honest response to a refusal; the foot-of-sidebar
   * alert (`tree.error`, set by `tree.remove` itself) is what explains it.
   *
   * Lives here rather than on `<WorkspaceSidebar>` because the toast this shows is a shell-level
   * overlay, not a sidebar-scoped one - see `shell-toasts.tsx` for why that move mattered.
   */
  async function requestDelete(item: TreeItem): Promise<void> {
    const title = item.title || 'Untitled';
    const { refusal } = await tree.remove(item.id);
    if (refusal !== null) {
      return;
    }

    shellToasts.push({
      key: item.id,
      message: item.hasChildren
        ? `Deleted "${title}" and everything inside it.`
        : `Deleted "${title}".`,
      action: {
        label: 'Undo',
        onAction: () => {
          void undoDeletion(item.id, title);
        },
      },
    });
  }

  /**
   * What Undo actually does, and what it says when it fails.
   *
   * `<Toast>` dismisses itself the instant its action is pressed, whatever that action does - so by
   * the time `tree.restore` could possibly fail, the toast that offered Undo is already gone, and a
   * reader who pressed it has every reason to believe it worked. Saying nothing further would be
   * the same silent-failure shape `requestDelete` above exists to avoid, just one step later - so a
   * restore failure pushes its own notice, in the item's own name, rather than leaving the item
   * gone with only the tree's own foot-of-sidebar alert (`tree.error`) to explain it.
   *
   * `autoFocus: false` (see `ShellToast`'s own comment): the round trip to here - Undo pressed, the
   * request sent, the response awaited - is time enough for the reader to have moved on to
   * something else entirely, unlike the primary deletion toast this one follows, which mounts while
   * the row it names is still what just happened. `role="status"` is left as it is rather than
   * reached past for `role="alert"`, despite this being a genuine failure: `<Toast>` deliberately
   * has no severity axis (see its own doc), and there is nothing time-critical about the message
   * that would justify one - it is something to notice and possibly retry, not something that
   * needs to interrupt whatever the reader is doing right now, and `status`'s `aria-live="polite"`
   * still gets it announced regardless of not grabbing focus.
   */
  async function undoDeletion(itemId: string, title: string): Promise<void> {
    const { refusal } = await tree.restore(itemId);
    if (refusal !== null) {
      shellToasts.push({
        key: `${itemId}-restore-failed`,
        message: `"${title}" could not be restored.`,
        autoFocus: false,
      });
    }
  }

  useRevealOpenPanes(tree, panes);
  useShellSearchShortcut(setSearchOpen);

  return (
    // design-token-exempt: device safe-area inset protects the header in standalone mode.
    <div className="flex h-dvh flex-col overflow-hidden bg-background pt-[env(safe-area-inset-top)] font-body text-foreground">
      {/* First focusable thing in the document, for everybody, on every screen. It used to live in
          a layout element that the route tree had stopped rendering, so in practice the app had no
          skip link at all.

          Every box property is re-applied under `focus:`, which looks redundant and is not:
          `.focus\:not-sr-only:focus` sets `padding: 0` at two-class specificity, so a plain `px-4`
          loses to it and the link paints as bare text in the very corner of the viewport - with the
          top and left of its focus ring outside the window, which is the one thing a focus
          indicator may not be. Offset from the corner and given elevation because it covers the
          header rather than sitting in the layout.

          The full stacking ladder, lowest to highest: pane content and the drawer's own scrim
          (`z-0`) < the drawer panel (`z-10`) < the profile menu (`z-20`) < the delete-undo toast
          (`z-[25]`, below) < the search overlay (`z-30`, `aria-modal="true"`) < this skip link
          (`z-50`). The drawer's own pair sit inside the pane row beside `<main>`, not inside
          `<main>` itself, but `<main>` carries `isolate` (below) precisely so nothing inside a pane
          - `sheet-grid.tsx`'s own `z-20`/`z-30`/`z-40` layers, or its drag overlay - can climb into
          the root context and outrank the header's popovers the way the drawer used to before it
          got its own numbers put in their place.

          The toast sits *below* the search overlay rather than above it, which used to be
          backwards: an earlier version of this comment argued the toast should outrank search
          because its undo window is time-limited, but the overlay it would have outranked is
          `role="dialog" aria-modal="true"` - telling assistive technology that everything outside
          it, the toast included, is unavailable for as long as it is open. A toast that visually
          sat on top of that while being declared unreachable by the platform's own modality
          contract was the contradiction, not the ordering. The honest trade-off this ladder now
          encodes: opening search while a toast is showing costs the toast's visibility for as long
          as search stays open, exactly as it costs every other item behind the dialog - the timer
          underneath keeps running regardless, so a long search session can still let the window
          close unseen, which is the correct read of "unavailable while the dialog is open" rather
          than a difference this ordering tries to paper over. `z-50` clears all of them, being the
          one control that must never be covered. */}
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
        onClick={(event) => {
          // `#main` is `inert` while the drawer covers it (see the `<main>` element below), so the
          // browser's own anchor-jump would land focus nowhere - the one thing "skip to content" is
          // for. Dismissing the drawer is part of getting to the content it is covering, the same
          // reading the sidebar's row-selection path gives it, so this closes it and sends
          // focus to the pane exactly as that path does. Left alone everywhere else: on a wide
          // screen, or a narrow one with the drawer already closed, `<main>` was never inert and the
          // default jump already works.
          if (narrow && sidebar.visible) {
            event.preventDefault();
            sidebar.toggle();
            focusPane(0);
          }
        }}
        className={`sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-surface focus:px-4 focus:py-2 focus:shadow-md ${focusRing}`}
      >
        Skip to content
      </a>

      {/* The rail, then everything else. This row exists so the rail can run the full height of
          the window at the very left edge - outboard of the workspace tree, alongside the header
          rather than under it - which is the whole point of a rail: the destinations that are not
          a document stay put while the tree scrolls, resizes, or slides away.

          It sits *after* the skip link in the document, not before, because the skip link must
          stay the first focusable thing on the page; and *outside* the pane row below, so the
          drawer's scrim - which is `absolute inset-0` of that row - does not cover it. That is the
          same call the header already makes for its own controls: the way out of the drawer must
          not be the thing the drawer covers.

          `min-h-0` so this row can shrink inside the `h-dvh` column, which is what gives the pane
          row underneath a definite height to scroll against. */}
      <div className="flex min-h-0 flex-1">
        {!narrow || sidebar.visible ? (
          <NavRail
            onImport={() => {
              // The import is modal, so there is no reason to leave a narrow-screen drawer open
              // underneath it. Closing it also means the imported root can be revealed cleanly in
              // the tree once the report is dismissed.
              if (narrow && sidebar.visible) {
                sidebar.toggle();
              }
              setWorkspaceImportOpen(true);
            }}
            onNavigate={() => {
              // A phone has no room to leave the tree open over the destination it was just asked
              // to leave for. Focus is left on the rail link that was activated rather than moved
              // into the pane: unlike a row in the tree, the link stays on screen, becomes the
              // current destination, and is a reasonable place to be standing. Left alone on a wide
              // screen, where the tree shares the screen rather than covering it.
              if (narrow && sidebar.visible) {
                sidebar.toggle();
              }
            }}
          />
        ) : null}

        <div className={`flex flex-1 flex-col ${paneClip}`}>
          <ShellHeader
            sidebarVisible={sidebar.visible}
            sidebarToggleRef={sidebarToggleRef}
            workspaceId={workspaceId}
            principal={principal}
            onToggleSidebar={sidebar.toggle}
            onOpenSearch={() => {
              setSearchOpen(true);
            }}
          />

          <WorkspaceInvitationNotice />

          {/* `relative`, so the drawer's scrim and panel - `absolute inset-*` - anchor to this row
              rather than to the viewport. That keeps the overlay below the header, over the pane
              content only: a phone has no room to share the tree beside a document, but the header's
              own toggle button is what closes the drawer, and covering it would take away the way
              back. */}
          <div className={`relative flex flex-1 ${paneClip}`}>
            <ShellSidebar
              narrow={narrow}
              sidebar={sidebar}
              tree={tree}
              selectedId={selectedId}
              openItem={{ openPreview, openPinned, openBeside, canOpenBeside, besideRefusal }}
              onDeleteItem={(item) => {
                void requestDelete(item);
              }}
              onStartStructured={startStructured}
              templates={templateLibrary.templates.filter(
                (template) => template.capabilities.canApply,
              )}
              templateStatus={templateLibrary.status}
              onStartTemplate={startTemplate}
              onBrowseTemplates={browseTemplates}
              treeRegionRef={treeRegionRef}
              sidebarToggleRef={sidebarToggleRef}
            />

            {/* The shell owns the main landmark so every screen has exactly one, and a screen that
                renders panels side by side does not have to nest them inside another.

                `inert` while the drawer is open: the native (React 19) way of making this region
                genuinely unreachable to pointer and assistive technology without a hand-rolled focus
                trap standing in for it - see `sidebar-drawer.tsx`'s own comment on why that trade was
                made. Scoped to the drawer being open rather than to `narrow` alone, since a narrow
                window with the drawer closed has nothing covering this region at all.

                `isolate` unconditionally, not only while the drawer is open: it creates a stacking
                context for everything a pane renders, so nothing in here - `sheet-grid.tsx`'s own
                `z-20`/`z-30`/`z-40` layers, or its drag overlay - can ever resolve into the *root*
                stacking context and paint over the header's own popovers. This is a different fix
                from the drawer's: the drawer sits *beside* `<main>`, not inside it, so `isolate` here
                does nothing for the drawer's own stacking - that was corrected separately, by giving
                the drawer numbers low enough to lose to the header outright (see the skip link's
                comment above for the full ladder). `isolation: isolate` does not change the containing
                block for `position: fixed`, so a fixed drag overlay still covers the viewport
                geometrically - this only stops it from painting above chrome that lives outside
                `<main>`. */}
            <main
              id="main"
              inert={narrow && sidebar.visible}
              className={`isolate flex flex-1 ${paneClip}`}
            >
              {/* Mutable server-owned template state has its own subscribed context. Router
                  Outlet context is retained for shell-owned navigation state only, so an async
                  catalog response cannot leave a mounted screen holding the initial capability
                  snapshot. */}
              <TemplateLibraryProvider library={templateLibrary}>
                <ItemDialogProvider tree={tree}>
                  <Outlet context={{ tree, selectedId } satisfies ShellContext} />
                </ItemDialogProvider>
              </TemplateLibraryProvider>
            </main>
          </div>
        </div>
      </div>

      <PwaControls />
      {narrow ? (
        <MobileNavigation
          workspaceId={workspaceId}
          treeOpen={sidebar.visible}
          creating={creating}
          onTree={sidebar.toggle}
          onSearch={() => {
            setSearchOpen(true);
          }}
          onCreate={() => {
            if (creating) return;
            setCreating(true);
            void tree
              .create(null, 'Untitled note')
              .then((outcome) => {
                if (outcome.id !== null) {
                  if (sidebar.visible) sidebar.toggle();
                  openPreview(outcome.id);
                } else announce(outcome.refusal ?? 'That could not be created.');
              })
              .catch(() => {
                announce('The note could not be created. Try again.');
              })
              .finally(() => {
                setCreating(false);
              });
          }}
        />
      ) : null}

      {workspaceImportOpen ? (
        <ImportDialog
          open
          parentId={null}
          getAccessToken={getAccessToken}
          onClose={() => {
            setWorkspaceImportOpen(false);
          }}
          onImported={(rootItemId) => {
            // Reveal the imported vault without opening it over the report the person is still
            // reading. This is the same promise as a contextual import inside an open note.
            void tree.reveal(rootItemId);
          }}
        />
      ) : null}

      <CommandPalette
        open={searchOpen}
        commands={builtInCommands({
          // Built here rather than inside the palette, because the shell is what holds each of
          // these. A palette that reached for them itself would be a second owner of the sidebar's
          // state and a second caller of the tree's create.
          createItem: () => {
            // Awaited for its answer, not fired and forgotten. `create` reports either an id or a
            // refusal, and dropping both meant the palette closed onto either a document nobody
            // could find or a silent failure - which is how people end up with six items called
            // "Untitled". The sidebar's own create has handled both since U8; this now does too.
            void tree.create(null, 'Untitled note').then((outcome) => {
              if (outcome.id !== null) {
                openPreview(outcome.id);
                return;
              }

              announce(outcome.refusal ?? 'That could not be created.');
            });
          },
          toggleSidebar: sidebar.toggle,

          // Null when nothing is open, so the command is left out of the list rather than offered
          // and inert. See commands.ts for why that distinction is worth a nullable.
          toggleBookmark:
            selectedId === null
              ? null
              : () => {
                  void toggleBookmark(selectedId);
                },
          openItemIsKept: selectedIsKept,
        })}
        onSelectItem={openPreview}
        onClose={() => {
          setSearchOpen(false);
        }}
      />

      <ShellToasts
        toasts={shellToasts.toasts}
        treeRegionRef={treeRegionRef}
        onDismiss={shellToasts.dismiss}
      />
    </div>
  );
}
