import { Button, Icon, PaneDivider, Text, focusRing } from '@nix/ui';
import { Download, LayoutTemplate, PanelRightClose, Save, Settings2, Upload } from 'lucide-react';
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate, useOutletContext } from 'react-router';

import type { ShellContext } from '../shell/shell-context';
import { PaneViewport } from '../layout/pane-viewport';
import {
  WIDE_ENOUGH_FOR_COMPANION_BESIDE,
  paneClip,
  paneColumn,
  paneScroller,
} from '../layout/regions';
import { useMediaQuery, useNarrowViewport } from '../layout/viewport';
import { NoteEditor } from '../editor/note-editor';
import { SheetEditor } from '../views/sheet/sheet-editor';

// Loaded at the moment somebody opens a canvas, not before: the editor is deliberately outside
// the application shell's first-load path, and a workspace of notes never needs it.
const CanvasEditor = lazy(async () => {
  const module = await import('../editor/canvas-editor');
  return { default: module.CanvasEditor };
});
import { announce } from '../a11y/announcer';
import { useAuth } from '../auth/auth-provider';
import { BookmarkButton } from '../bookmarks/bookmark-button';
import { ExportDialog } from '../export/export-dialog';
import { ImportDialog } from '../import/import-dialog';
import { FileViewer } from '../files/file-viewer';
import { PaneGroup } from '../panes/pane-group';
import { PaneProvider, usePaneIndex } from '../panes/pane-context';
import { focusPane, paneElementId } from '../panes/pane-params';
import { PaneSplitControl } from '../panes/pane-split-control';
import { usePanes, type PaneState } from '../panes/pane-state';
import { usePaneCycling } from '../panes/use-pane-cycling';
import { useItemProperties } from '../properties/use-item-properties';
import { useTabOrientationStore } from '../tabs/tab-orientation-store';
import { DocumentTabStrip } from '../tabs/document-tab-strip';
import type { TabTransferPayload } from '../tabs/tab-transfer';
import { useTabStore } from '../tabs/tab-store';
import { useOpenItem } from '../tabs/use-open-item';
import { useTabTransfer } from '../tabs/use-tab-transfer';
import { ContainerView } from '../views/core/container-view';
import { DOCUMENT_VIEW, type View } from '../views/core/container-model';
import { useContainer } from '../views/core/use-container';
import { ItemPanel } from '../panel/item-panel';
import { browserStorage } from '../lib/browser-storage';
import { readPanelOpen, storePanelOpen } from '../panel/panel-state';
import { useViewState } from '../views/core/view-state';
import { ViewSwitcher } from '../views/core/view-switcher';
import { useTemplateLibrary } from '../templates/template-library-context';

/**
 * One item, open.
 *
 * **There is one kind of item, and this is its one screen.** It used to fork: a folder opened into
 * its views and could not hold a document, a note opened into an editor and could not hold
 * anything. That split was never in the schema - every row has always had a parent, a property
 * schema and a views column - so it was the interface refusing what the data allowed.
 *
 * What is left is two axes, and keeping them distinct is the thing to preserve here:
 *
 * - the item's **body**, which is its own content, and
 * - its **views**, which are ways of looking at its children.
 *
 * Only one is on screen at a time, so one switcher chooses, and the item remembers the choice. An
 * item nobody has configured a view on shows its body and no chrome whatsoever, which is every
 * plain note - the switcher returns nothing rather than offering a single "Document" tab.
 *
 * The tree is not here. It belongs to the shell, because it is how you move around the product
 * rather than part of this screen.
 */
export function EditorPage(): ReactNode {
  const { tree } = useOutletContext<ShellContext>();
  const templateLibrary = useTemplateLibrary();
  const { panes, split, sizes, requested, closePane, setSplit, setSizes } = usePanes();
  const paneClosed = useTabStore((state) => state.paneClosed);
  const narrow = useNarrowViewport();
  const [draggedTab, setDraggedTab] = useState<TabTransferPayload | null>(null);

  const paneCount = panes.length;
  const { moveTab } = useTabTransfer(panes.map((pane) => pane.index));

  // F6 and Shift F6 cycle focus between the pane regions - see the hook for why it is claimed
  // only while there is more than one pane to cycle.
  usePaneCycling(paneCount);

  const close = useCallback(
    (index: number, title: string): void => {
      const left = paneCount - 1;
      announce(
        `Closed ${title || 'Untitled'}. ${left === 1 ? '1 pane' : `${String(left)} panes`} open.`,
      );
      closePane(index);

      // The tab store's own renumbering has to run from the same call site as the address's, or
      // a pane's tab strip ends up belonging to whichever pane used to sit at that index.
      paneClosed(index, paneCount);

      // The button that was focused is about to be unmounted with its pane, so focus goes to
      // whatever takes its place - the pane that shifts down into this index, or the last one
      // left. Without this it falls to the document body and the reader loses their place.
      focusPane(Math.min(index, left - 1));
    },
    [closePane, paneClosed, paneCount],
  );

  if (panes.length === 0) {
    return (
      <div
        id={paneElementId(0)}
        // Focusable only programmatically, the same as a real pane's `<article>` - this is pane
        // zero in every sense that matters to `focusPane(0)` and to the skip link, which lands
        // here when the drawer it just closed was covering an empty workspace rather than a pane.
        tabIndex={-1}
        className="flex flex-1 items-center justify-center px-6 text-center"
      >
        <Text variant="note" tone="muted" className="max-w-sm">
          {tree.status === 'loading'
            ? 'Loading the workspace…'
            : tree.childrenOf(null).length === 0
              ? // Below `sm` the tree starts as a closed drawer (see `use-sidebar.ts`), so the
                // control this sentence used to name - "create one" - is not on screen; naming the
                // toggle that opens it instead is the honest answer, both here and in the sibling
                // branch below.
                narrow
                ? 'Open the workspace tree to create your first note.'
                : 'This workspace has no items yet. Create a note to begin.'
              : narrow
                ? 'Open the workspace tree to pick a note.'
                : 'Select a note from the tree, or create one.'}
        </Text>
      </div>
    );
  }

  // What the address asked for but this window cannot draw. Saying nothing would mean somebody
  // opening a colleague's two-pane link on a phone sees one document with no sign that the message
  // held two - the interface knowing something it will not tell the reader.
  const hidden = (requested ?? panes.length) - panes.length;

  return (
    <div className={paneColumn}>
      {paneCount > 1 ? <PaneSplitControl orientation={split} onChange={setSplit} /> : null}
      <PaneGroup
        panes={panes}
        split={split}
        sizes={sizes}
        onSizes={setSizes}
        describePane={(pane) => describe(tree.find(pane.itemId)?.title, pane.index)}
        renderPane={(pane) => (
          <PaneContents
            pane={pane}
            tree={tree}
            visiblePanes={panes}
            draggedTab={draggedTab}
            onTabDragStarted={setDraggedTab}
            onTabDragEnded={() => {
              setDraggedTab(null);
            }}
            onMoveTab={moveTab}
            canManageTemplates={templateLibrary.capabilities.canManage}
            canApplyTemplates={
              templateLibrary.status === 'ready' &&
              templateLibrary.templates.some((template) => template.capabilities.canApply)
            }
            hiddenPanes={pane.index === 0 ? hidden : 0}
            paneLabel={
              paneCount > 1
                ? `Pane ${String(pane.index + 1)} of ${String(paneCount)}: ${describe(tree.find(pane.itemId)?.title, pane.index)}`
                : undefined
            }
            onClose={
              paneCount > 1
                ? () => {
                    close(pane.index, tree.find(pane.itemId)?.title ?? '');
                  }
                : undefined
            }
          />
        )}
      />
    </div>
  );
}

/**
 * What to call a pane whose item has no title, or has not loaded yet.
 *
 * `?? ` alone does not catch an empty string, and an untitled note is ordinary - so a divider
 * would otherwise be announced as "Resize  and Notes", and two of them before the tree loads
 * would carry the same name as each other.
 */
function describe(title: string | undefined, index: number): string {
  return title !== undefined && title.length > 0 ? title : `pane ${String(index + 1)}`;
}

interface PaneContentsProps {
  readonly pane: PaneState;
  readonly tree: ShellContext['tree'];
  readonly visiblePanes: readonly PaneState[];
  readonly draggedTab: TabTransferPayload | null;
  readonly onTabDragStarted: (payload: TabTransferPayload) => void;
  readonly onTabDragEnded: () => void;
  readonly onMoveTab: (
    payload: TabTransferPayload,
    destinationPane: number,
    title: string,
  ) => boolean;

  /** How many panes this address holds that this window is too narrow to draw. */
  readonly hiddenPanes: number;
  readonly canManageTemplates: boolean;
  readonly canApplyTemplates: boolean;
  readonly onClose: (() => void) | undefined;
  readonly paneLabel: string | undefined;
}

/**
 * One pane's item, resolved.
 *
 * Split out of `EditorPage` because it has to run inside `PaneProvider` - `useOpenItem` reads the
 * pane from context (by way of `usePaneIndex`), and a component that called it above the provider
 * would be reading the first pane's parameters no matter which pane it was drawing.
 *
 * Breadcrumbs and in-document links open through `useOpenItem` rather than a bare
 * `useSelectedItem().select`, the same as a sidebar click - a link inside pane 2 to a document
 * that is already open, backgrounded, in pane 1 has to focus it there, not open a second copy.
 */
function PaneContents({
  pane,
  tree,
  visiblePanes,
  draggedTab,
  onTabDragStarted,
  onTabDragEnded,
  onMoveTab,
  onClose,
  paneLabel,
  hiddenPanes,
  canManageTemplates,
  canApplyTemplates,
}: PaneContentsProps): ReactNode {
  const { openPreview } = useOpenItem();
  const tabPinned = useTabStore((state) => state.tabPinned);
  const orientation = useTabOrientationStore((state) => state.orientation);
  const item = tree.find(pane.itemId);

  return (
    <article
      id={paneElementId(pane.index)}
      // Focusable only programmatically: a pane is a landmark to be sent to, not a stop on the way
      // through. Without it, closing a pane drops focus to the document body and a keyboard user
      // has to Tab through the tree and a whole editor to get back to where they were.
      tabIndex={-1}
      aria-label={paneLabel}
      className={paneColumn}
    >
      {/* A row when tabs are vertical, so the rail sits beside the rest of the pane rather than
          above it; a column otherwise, which is the arrangement this always was. Orientation is
          one preference for every pane (`tab-orientation-store.ts`), read here rather than
          threaded down, because this is the one place that has to lay the pane out around it. */}
      <div
        className={`flex flex-1 ${paneClip} ${orientation === 'vertical' ? 'flex-row' : 'flex-col'}`}
      >
        {/* Mounted here rather than inside `OpenItem`, and above the not-found branch below: an
            item resolving, forbidden, or failed must not take the rest of the strip down with it,
            or a person could not click back to a tab that is perfectly fine. */}
        <DocumentTabStrip
          paneIndex={pane.index}
          tree={tree}
          activeItemId={pane.itemId}
          visiblePanes={visiblePanes}
          draggedTab={draggedTab}
          onTabDragStarted={onTabDragStarted}
          onTabDragEnded={onTabDragEnded}
          onMoveTab={onMoveTab}
          onClosePane={onClose}
        />

        <div className={paneColumn}>
          {hiddenPanes > 0 ? (
            <Text variant="caption" as="p" tone="muted" className="shrink-0 px-8 pb-1 pt-1">
              {hiddenPanes === 1
                ? 'One more pane in this link opens on a wider screen.'
                : `${String(hiddenPanes)} more panes in this link open on a wider screen.`}
            </Text>
          ) : null}

          {item === null ? (
            <NotFoundItem tree={tree} pane={pane} onClose={onClose} />
          ) : (
            // Keyed on the item throughout: switching notes has to build a new Yjs document and
            // a new title draft rather than reuse one, which is the failure that would otherwise
            // carry one note's text into another.
            <OpenItem
              key={item.id}
              tree={tree}
              itemId={item.id}
              title={item.title}
              bodyKind={item.type}
              canManageTemplates={canManageTemplates}
              canApplyTemplates={canApplyTemplates}
              onOpen={openPreview}
              onClose={onClose}
              onCommit={() => {
                tabPinned(pane.index, item.id);
              }}
            />
          )}
        </div>
      </div>
    </article>
  );
}

interface NotFoundItemProps {
  readonly tree: ShellContext['tree'];
  readonly pane: PaneState;
  readonly onClose: (() => void) | undefined;
}

/**
 * Four different things, said differently. The tree loads roots and then children on expansion,
 * so anything nested is absent until a reveal walks up to it - and that walk is several requests,
 * during which "not in this workspace" is simply untrue. It is also the wrong sentence for an
 * item somebody may not read, which is theirs to ask about rather than absent, and the wrong
 * sentence again when it is the tree itself that failed.
 */
function NotFoundItem({ tree, pane, onClose }: NotFoundItemProps): ReactNode {
  const reveal = tree.revealOf(pane.itemId);
  const waiting = tree.status === 'loading' || reveal === null || reveal === 'revealing';
  const failed = reveal === 'failed' || tree.status === 'error';

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <Text variant="note" tone="muted" className="max-w-sm">
        {waiting
          ? 'Finding this item…'
          : failed
            ? 'Something went wrong finding this item.'
            : reveal === 'forbidden'
              ? "You can't view this item."
              : 'We cannot find that item. It may have been deleted.'}
      </Text>

      {/* Without these a bad link is a dead end: the pane shows a sentence and offers nothing,
          and in a single-pane arrangement there is no other control on the screen at all. A
          failure is the one outcome worth another go, so it gets a way to take it. */}
      <div className="flex items-center gap-2">
        {failed ? (
          <Button
            variant="secondary"
            onClick={() => {
              void tree.retryReveal(pane.itemId);
            }}
          >
            Try again
          </Button>
        ) : null}

        {waiting || onClose === undefined ? null : (
          <Button variant="ghost" onClick={onClose}>
            Close this pane
          </Button>
        )}
      </div>
    </div>
  );
}

interface OpenItemProps {
  readonly tree: ShellContext['tree'];
  readonly itemId: string;
  readonly title: string;

  /** The item's `type`: how its own body is drawn. Never gates what it may contain. */
  readonly bodyKind: string;
  readonly canManageTemplates: boolean;
  readonly canApplyTemplates: boolean;
  readonly onOpen: (itemId: string) => void;

  /** Closes this pane, or absent when it is the only one and there is nothing to close to. */
  readonly onClose: (() => void) | undefined;

  /** Editing the title is a commitment to this document - it gets pinned, the way a double-click
   * from the tree does. */
  readonly onCommit: () => void;
}

function OpenItem({
  tree,
  itemId,
  title,
  bodyKind,
  canManageTemplates,
  canApplyTemplates,
  onOpen,
  onClose,
  onCommit,
}: OpenItemProps): ReactNode {
  const navigate = useNavigate();
  // Creation goes through the tree, which is the only thing that knows how to put a new item into
  // the store the sidebar reads and expand its parent so it is visible. The container borrows it
  // rather than growing a second one.
  const createChild = useCallback(
    async (title: string, properties?: Record<string, unknown>): Promise<string | null> => {
      const { refusal } = await tree.create(itemId, title, 'note', properties);
      return refusal;
    },
    [itemId, tree],
  );

  const container = useContainer(itemId, createChild);
  const { viewId, selectView } = useViewState();
  // Remembered the way the tree's own collapse is, and for the same reason: somebody who closed it
  // wanted the width back, and finding it open again would make the control feel like it had not
  // worked.
  const [panelOpen, setPanelOpen] = useState(() => readPanelOpen(browserStorage()));

  // The dialog is mounted only while it is open, so an export that was never started costs nothing
  // and a closed one keeps no half-chosen format from last time.
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const { getAccessToken } = useAuth();
  const paneIndex = usePaneIndex();

  function togglePanel(): void {
    setPanelOpen((current) => {
      storePanelOpen(browserStorage(), !current);
      return !current;
    });
  }

  const details = useItemProperties(itemId);

  const views = useMemo(() => container.views?.views ?? [], [container.views]);
  const unrenderable = container.views?.unrenderable ?? [];

  // What the item says opens, unless the address says otherwise. The URL wins because it is the
  // more specific statement - somebody chose it, possibly in a link they were handed - and the
  // stored default is the starting point rather than the authority.
  const activeId = viewId ?? container.views?.default ?? DOCUMENT_VIEW;

  const active = useMemo<View | null>(
    () => views.find((view) => view.id === activeId) ?? null,
    [activeId, views],
  );

  // The body, when nothing else was chosen or when what was chosen is not a view this item has.
  const showingDocument = active === null;

  return (
    <>
      <ItemHeader
        tree={tree}
        itemId={itemId}
        title={title}
        bodyKind={bodyKind}
        onNavigate={onOpen}
        onCommit={onCommit}
      />

      <div className="flex shrink-0 flex-col sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1 overflow-x-auto">
          <ViewSwitcher
            views={views}
            unrenderable={unrenderable}
            activeViewId={showingDocument ? DOCUMENT_VIEW : activeId}
            documentLabel="Document"
            onSelect={(chosen) => {
              selectView(chosen);

              // The deliberate click, and the only place the stored default is written. Arriving at
              // a URL that already carries ?view= runs none of this - otherwise following somebody
              // else's link would rewrite what this item opens as, for everybody, on behalf of the
              // person who followed it.
              void container.setDefaultView(chosen);
            }}
          />
        </div>

        {/* One control rather than two, and the panel it opens configures this item and nothing
            else. Somebody who wants a board wants it for the item they are looking at, and sending
            them to a settings page to say so loses their place.

            `pr-8`, not `px-2`: this row and the view switcher beside it are one flex row, sandwiched
            between the item header and the document body, both `px-8` on both sides - and every
            other chrome row in this pane (the toolbar, the sync footer, the canvas editor's own
            right-aligned row) is box-aligned to that same edge, not label-aligned to it. A `pr-6`
            here once lined a ghost button's *label* up with the header's title, but the button's
            own transparent border still paints a hover/focus wash at its real box edge - 20.4px
            from the right rather than 27.2px - so whichever of these two controls happens to be
            focused or hovered read as 6.8px out of line with the header above it. `pr-8` puts the
            box where every sibling row's box already is; the label sits a further `px-2` in from
            there, which is the same relationship the switcher's own tabs have to their nav. */}
        <div className="flex w-full shrink-0 flex-nowrap items-center justify-start gap-1 overflow-x-auto px-3 py-1.5 sm:w-auto sm:flex-wrap sm:justify-end sm:overflow-visible sm:pl-2 sm:pr-8">
          {/* The thing you are reading is the thing you can keep. First in the row because it acts
              on the document rather than on the pane around it, which the two controls beside it
              both do. */}
          <BookmarkButton compact itemId={itemId} title={title} />

          {/* Beside the bookmark for the reason stated above it: both act on the document rather
              than on the pane around it, and the two controls after them do not. */}
          <Button
            variant="ghost"
            className="px-2 py-1 text-xs"
            onClick={() => {
              setExportOpen(true);
            }}
          >
            <Icon icon={Download} size="sm" />
            Export
          </Button>

          {/* Beside Export because they are the same door swinging the other way: what leaves as
              Markdown can come back as Markdown, under the item being looked at. */}
          <Button
            variant="ghost"
            className="px-2 py-1 text-xs"
            onClick={() => {
              setImportOpen(true);
            }}
          >
            <Icon icon={Upload} size="sm" />
            Import
          </Button>

          {canApplyTemplates ? (
            <Button
              variant="ghost"
              className="px-2 py-1 text-xs"
              onClick={() => {
                void navigate(`/templates?target=${encodeURIComponent(itemId)}`);
              }}
            >
              <Icon icon={LayoutTemplate} size="sm" />
              Apply template
            </Button>
          ) : null}

          {canManageTemplates ? (
            <Button
              variant="ghost"
              className="px-2 py-1 text-xs"
              onClick={() => {
                void navigate(`/templates/new?sourceItem=${encodeURIComponent(itemId)}`);
              }}
            >
              <Icon icon={Save} size="sm" />
              Save as template
            </Button>
          ) : null}

          <Button
            variant="ghost"
            className="px-2 py-1 text-xs"
            aria-expanded={panelOpen}
            onClick={togglePanel}
          >
            <Icon icon={Settings2} size="sm" />
            Settings
          </Button>

          {/* Text, not a bare X. An unlabelled cross beside a document's own title reads as
              "delete this note" to everybody who has ever seen one, and the header already has a
              text-labelled control next to it to match. */}
          {onClose === undefined ? null : (
            <Button variant="ghost" className="px-2 py-1 text-xs" onClick={onClose}>
              <Icon icon={PanelRightClose} size="sm" />
              Close pane
            </Button>
          )}
        </div>
      </div>

      <div className={`flex flex-1 ${paneClip}`}>
        <div className={paneColumn}>
          {showingDocument ? (
            bodyKind === 'canvas' ? (
              <Suspense
                fallback={
                  <Text
                    variant="note"
                    as="div"
                    tone="muted"
                    className="flex flex-1 items-center justify-center"
                  >
                    Loading the canvas…
                  </Text>
                }
              >
                <CanvasEditor itemId={itemId} />
              </Suspense>
            ) : bodyKind === 'spreadsheet' ? (
              <SheetEditor itemId={itemId} />
            ) : bodyKind === 'file' ? (
              <FileViewer itemId={itemId} />
            ) : (
              // Every kind this build has not heard of is prose - the same open-set rule
              // the server applies, so the two never disagree about what a body is.
              <NoteEditor itemId={itemId} />
            )
          ) : (
            <section aria-label="Container" className={paneColumn}>
              {/* A refused write is reported once, by the view that made it. The renderer knows what
              snapped back and where, which is what somebody needs; this used to draw a second
              banner saying the same thing in different words, directly under a comment claiming it
              did not. */}

              {/* The pane's scroller. It is written y-only to say what it is for, though CSS makes
                  it a scroll container on both axes either way - what keeps the horizontal one
                  dormant is that the view inside brings its own and this can shrink to fit around
                  it. See `paneScroller`. */}
              <PaneViewport className={paneScroller}>
                {active.companionViewId === null || active.companionViewId === undefined ? (
                  <ContainerView container={container} view={active} onOpen={onOpen} />
                ) : (
                  <CompanionViewPair
                    key={`${itemId}:${active.id}:${active.companionViewId}`}
                    itemId={itemId}
                    paneIndex={paneIndex}
                    placement={active.companionPlacement}
                    primaryName={active.name}
                    companionName={
                      views.find((candidate) => candidate.id === active.companionViewId)?.name ??
                      'Companion view'
                    }
                    primary={<ContainerView container={container} view={active} onOpen={onOpen} />}
                    companion={
                      <PaneProvider index={paneIndex + 3}>
                        <ContainerView
                          container={container}
                          view={
                            views.find((candidate) => candidate.id === active.companionViewId) ??
                            null
                          }
                          onOpen={onOpen}
                        />
                      </PaneProvider>
                    }
                  />
                )}
              </PaneViewport>
            </section>
          )}
        </div>

        {panelOpen ? (
          <ItemPanel container={container} details={details} onClose={togglePanel} />
        ) : null}
      </div>

      {exportOpen ? (
        <ExportDialog
          open
          itemId={itemId}
          // Straight from the tree node, which already carries it - the scope picker is hidden for
          // an item with nothing inside rather than offering a question with one real answer.
          hasChildren={tree.find(itemId)?.hasChildren ?? false}
          getAccessToken={getAccessToken}
          onClose={() => {
            setExportOpen(false);
          }}
        />
      ) : null}

      {importOpen ? (
        <ImportDialog
          open
          parentId={itemId}
          getAccessToken={getAccessToken}
          onClose={() => {
            setImportOpen(false);
          }}
          onImported={(rootItemId) => {
            // Revealed rather than navigated to: the person is mid-import in a dialog that still
            // has the report to show, so the tree opens to the result without yanking the page.
            void tree.reveal(rootItemId);
          }}
        />
      ) : null}
    </>
  );
}

interface ItemHeaderProps {
  readonly tree: ShellContext['tree'];
  readonly itemId: string;
  readonly title: string;
  readonly bodyKind: string;
  readonly onNavigate: (itemId: string) => void;

  /** Editing the title is a commitment to this document. */
  readonly onCommit: () => void;
}

function ItemHeader({
  tree,
  itemId,
  title,
  bodyKind,
  onNavigate,
  onCommit,
}: ItemHeaderProps): ReactNode {
  const trail = tree.breadcrumbs(itemId);
  // Keyed on the item by its caller, so the draft is rebuilt rather than carried. A title held in
  // state and not reset is the classic mirrored-prop bug: navigating from one note to another would
  // leave the previous note's name in the field, and the next blur would save it onto the new one.
  const [draft, setDraft] = useState(title);
  const titleRef = useRef<HTMLInputElement>(null);

  // A freshly created item arrives called "Untitled note" and the next thing anybody does is name
  // it. Selecting the placeholder means that is one keystroke rather than a click, a select-all and
  // a keystroke - and because the text is selected rather than cleared, somebody who came here to
  // read instead of rename loses nothing by clicking away.
  useEffect(() => {
    if (title.startsWith('Untitled')) {
      titleRef.current?.focus();
      titleRef.current?.select();
    }
  }, [itemId, title]);

  return (
    <header className="px-4 pb-3 pt-4 sm:px-8">
      {trail.length > 1 ? (
        <nav aria-label="Breadcrumb" className="mb-1 flex flex-wrap items-center text-xs">
          {trail.slice(0, -1).map((ancestor) => (
            <span key={ancestor.id} className="flex items-center">
              {/* Navigable, not decorative. A trail that shows where you are and cannot take you
                  there is a label pretending to be a control, and everybody tries to click it. */}
              <button
                type="button"
                onClick={() => {
                  onNavigate(ancestor.id);
                }}
                className={`text-muted underline-offset-2 hover:text-foreground hover:underline ${focusRing}`}
              >
                {ancestor.title || 'Untitled'}
              </button>
              <span aria-hidden="true" className="px-1 text-muted">
                /
              </span>
            </span>
          ))}
        </nav>
      ) : null}

      <input
        ref={titleRef}
        aria-label={`${bodyKind === 'canvas' ? 'Canvas' : bodyKind === 'spreadsheet' ? 'Spreadsheet' : 'Note'} title`}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          onCommit();
        }}
        onBlur={() => {
          // On blur rather than on every keystroke: a rename is a write to the item row, and one
          // per character would be a request per character.
          if (draft !== title) {
            void tree.rename(itemId, draft);
          }
        }}
        // No `outline-none` beside the ring. In Tailwind v4 that utility sets `--tw-outline-style:
        // none` on the element, and `focus-visible:outline-2` resolves its style through the same
        // variable - so the two together left the field that renames an item with no visible focus
        // at all. `focusRing` replaces the UA outline rather than removing it, which is the whole
        // point of the primitive.
        className={`w-full bg-transparent font-heading text-xl uppercase sm:text-2xl ${focusRing}`}
      />
    </header>
  );
}

interface CompanionViewPairProps {
  readonly itemId: string;
  readonly paneIndex: number;
  readonly placement: 'below' | 'beside' | null | undefined;
  readonly primaryName: string;
  readonly companionName: string;
  readonly primary: ReactNode;
  readonly companion: ReactNode;
}

/**
 * A primary and companion view sharing one viewport.
 *
 * The splitter is intentionally local to this composition. It controls only the two views an item
 * currently declares, so serializing it into the pane URL would falsely make an item's own layout
 * part of a reader's multi-pane arrangement. A new composition starts balanced; an adjustment
 * survives ordinary re-renders and remains available to pointer and keyboard users alike.
 */
function CompanionViewPair({
  itemId,
  paneIndex,
  placement,
  primaryName,
  companionName,
  primary,
  companion,
}: CompanionViewPairProps): ReactNode {
  const wide = useMediaQuery(WIDE_ENOUGH_FOR_COMPANION_BESIDE);
  const orientation = placement === 'beside' && wide ? 'vertical' : 'horizontal';
  const [shares, setShares] = useState<readonly [number, number]>([50, 50]);
  const pairRef = useRef<HTMLDivElement>(null);
  const primaryRegionId = `companion-primary-${String(paneIndex)}-${itemId}`;

  function preview(primaryShare: number, companionShare: number): void {
    const pair = pairRef.current;
    if (pair === null) return;
    pair.style.setProperty('--companion-primary-share', String(primaryShare));
    pair.style.setProperty('--companion-secondary-share', String(companionShare));
  }

  function commit(primaryShare: number, companionShare: number): void {
    setShares([primaryShare, companionShare]);
  }

  const style: Record<string, string> = {
    '--companion-primary-share': String(shares[0]),
    '--companion-secondary-share': String(shares[1]),
  };
  const vertical = orientation === 'vertical';

  return (
    <div
      ref={pairRef}
      style={style}
      className={`flex min-h-full min-w-0 ${vertical ? 'flex-row' : 'flex-col'}`}
    >
      <section
        id={primaryRegionId}
        aria-label={primaryName}
        style={{ flexGrow: 'var(--companion-primary-share)', flexBasis: 0 }} // design-token-exempt: a companion pane's share is a runtime ratio adjusted by its divider, not a design-scale value.
        className="min-h-0 min-w-0"
      >
        {primary}
      </section>
      <PaneDivider
        orientation={orientation}
        before={shares[0]}
        after={shares[1]}
        beforeName={primaryName}
        afterName={companionName}
        controls={primaryRegionId}
        onPreview={preview}
        onCommit={commit}
      />
      <section
        aria-label={companionName}
        style={{ flexGrow: 'var(--companion-secondary-share)', flexBasis: 0 }} // design-token-exempt: a companion pane's share is a runtime ratio adjusted by its divider, not a design-scale value.
        className="min-h-0 min-w-0"
      >
        {companion}
      </section>
    </div>
  );
}
