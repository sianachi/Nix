import { Button, Icon, focusRing } from '@nix/ui';
import { PanelRightClose, Settings2 } from 'lucide-react';
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
import { useOutletContext } from 'react-router';

import type { ShellContext } from '../app/app-shell';
import { paneClip, paneColumn, paneScroller } from '../app/layout';
import { NoteEditor } from '../editor/note-editor';
import { SheetEditor } from '../sheet/sheet-editor';

// Loaded at the moment somebody opens a canvas, not before: Excalidraw and its styles are
// the single largest thing the editor can pull in, and a workspace of notes never needs it.
const CanvasEditor = lazy(async () => {
  const module = await import('../editor/canvas-editor');
  return { default: module.CanvasEditor };
});
import { announce } from '../app/announcer';
import { PaneGroup } from '../panes/pane-group';
import { focusPane, paneElementId } from '../panes/pane-params';
import { usePanes, type PaneState } from '../panes/pane-state';
import { useItemProperties } from '../properties/use-item-properties';
import { useSelectedItem } from '../routing/selected-item';
import { ContainerView } from '../views/container-view';
import { DOCUMENT_VIEW, type View } from '../views/container-model';
import { useContainer } from '../views/use-container';
import { ItemPanel } from './item-panel';
import { browserStorage } from '../theme/theme-store';
import { readPanelOpen, storePanelOpen } from './panel-state';
import { useViewState } from '../views/view-state';
import { ViewSwitcher } from '../views/view-switcher';

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
  const { panes, split, sizes, requested, closePane, setSizes } = usePanes();

  const paneCount = panes.length;

  const close = useCallback(
    (index: number, title: string): void => {
      const left = paneCount - 1;
      announce(
        `Closed ${title || 'Untitled'}. ${left === 1 ? '1 pane' : `${String(left)} panes`} open.`,
      );
      closePane(index);

      // The button that was focused is about to be unmounted with its pane, so focus goes to
      // whatever takes its place - the pane that shifts down into this index, or the last one
      // left. Without this it falls to the document body and the reader loses their place.
      focusPane(Math.min(index, left - 1));
    },
    [closePane, paneCount],
  );

  if (panes.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center">
        <p className="max-w-sm text-sm text-muted">
          {tree.status === 'loading'
            ? 'Loading the workspace…'
            : tree.childrenOf(null).length === 0
              ? 'This workspace has no items yet. Create a note to begin.'
              : 'Select a note from the tree, or create one.'}
        </p>
      </div>
    );
  }

  // What the address asked for but this window cannot draw. Saying nothing would mean somebody
  // opening a colleague's two-pane link on a phone sees one document with no sign that the message
  // held two - the interface knowing something it will not tell the reader.
  const hidden = (requested ?? panes.length) - panes.length;

  return (
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

  /** How many panes this address holds that this window is too narrow to draw. */
  readonly hiddenPanes: number;
  readonly onClose: (() => void) | undefined;
  readonly paneLabel: string | undefined;
}

/**
 * One pane's item, resolved.
 *
 * Split out of `EditorPage` because it has to run inside `PaneProvider` - `useSelectedItem` reads
 * the pane from context, and a component that called it above the provider would be reading the
 * first pane's parameters no matter which pane it was drawing.
 */
function PaneContents({
  pane,
  tree,
  onClose,
  paneLabel,
  hiddenPanes,
}: PaneContentsProps): ReactNode {
  const { select } = useSelectedItem();
  const item = tree.find(pane.itemId);

  if (item === null) {
    // Four different things, said differently. The tree loads roots and then children on
    // expansion, so anything nested is absent until a reveal walks up to it - and that walk is
    // several requests, during which "not in this workspace" is simply untrue. It is also the
    // wrong sentence for an item somebody may not read, which is theirs to ask about rather than
    // absent, and the wrong sentence again when it is the tree itself that failed.
    const reveal = tree.revealOf(pane.itemId);
    const waiting = tree.status === 'loading' || reveal === null || reveal === 'revealing';
    const failed = reveal === 'failed' || tree.status === 'error';

    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="max-w-sm text-sm text-muted">
          {waiting
            ? 'Finding this item…'
            : failed
              ? 'Something went wrong finding this item.'
              : reveal === 'forbidden'
                ? "You can't view this item."
                : 'We cannot find that item. It may have been deleted.'}
        </p>

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

  // Keyed on the item throughout: switching notes has to build a new Yjs document and a new title
  // draft rather than reuse one, which is the failure that would otherwise carry one note's text
  // into another.
  return (
    <OpenItem
      key={item.id}
      tree={tree}
      itemId={item.id}
      title={item.title}
      bodyKind={item.type}
      paneIndex={pane.index}
      hiddenPanes={hiddenPanes}
      onOpen={select}
      onClose={onClose}
      paneLabel={paneLabel}
    />
  );
}

interface OpenItemProps {
  readonly tree: ShellContext['tree'];
  readonly itemId: string;

  /** Which pane this is drawn in, so it can be addressed for focus. */
  readonly paneIndex: number;

  /** How many panes this address holds that this window is too narrow to draw. */
  readonly hiddenPanes: number;
  readonly title: string;

  /** The item's `type`: how its own body is drawn. Never gates what it may contain. */
  readonly bodyKind: string;
  readonly onOpen: (itemId: string) => void;

  /** Closes this pane, or absent when it is the only one and there is nothing to close to. */
  readonly onClose: (() => void) | undefined;

  /**
   * What this region is called, when there is more than one of it.
   *
   * Absent for a single pane, because "Pane 1 of 1" is noise. With two open, an unnamed second
   * article is all a screen reader would otherwise be told about the screen having split.
   */
  readonly paneLabel: string | undefined;
}

function OpenItem({
  tree,
  itemId,
  paneIndex,
  hiddenPanes,
  title,
  bodyKind,
  onOpen,
  onClose,
  paneLabel,
}: OpenItemProps): ReactNode {
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
    <article
      id={paneElementId(paneIndex)}
      // Focusable only programmatically: a pane is a landmark to be sent to, not a stop on the way
      // through. Without it, closing a pane drops focus to the document body and a keyboard user
      // has to Tab through the tree and a whole editor to get back to where they were.
      tabIndex={-1}
      aria-label={paneLabel}
      className={paneColumn}
    >
      <ItemHeader tree={tree} itemId={itemId} title={title} onNavigate={onOpen} />

      {hiddenPanes > 0 ? (
        <p className="shrink-0 px-8 pb-1 text-xs text-muted">
          {hiddenPanes === 1
            ? 'One more pane in this link opens on a wider screen.'
            : `${String(hiddenPanes)} more panes in this link open on a wider screen.`}
        </p>
      ) : null}

      <div className="flex shrink-0 items-center">
        <div className="min-w-0 flex-1">
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
            them to a settings page to say so loses their place. */}
        <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
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
                  <div className="flex flex-1 items-center justify-center text-sm text-muted">
                    Loading the canvas…
                  </div>
                }
              >
                <CanvasEditor itemId={itemId} />
              </Suspense>
            ) : bodyKind === 'spreadsheet' ? (
              <SheetEditor itemId={itemId} />
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
              <div className={paneScroller}>
                <ContainerView container={container} view={active} onOpen={onOpen} />
              </div>
            </section>
          )}
        </div>

        {panelOpen ? (
          <ItemPanel container={container} details={details} onClose={togglePanel} />
        ) : null}
      </div>
    </article>
  );
}

interface ItemHeaderProps {
  readonly tree: ShellContext['tree'];
  readonly itemId: string;
  readonly title: string;
  readonly onNavigate: (itemId: string) => void;
}

function ItemHeader({ tree, itemId, title, onNavigate }: ItemHeaderProps): ReactNode {
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
    <header className="px-8 pb-3 pt-4">
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
        aria-label="Note title"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
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
        className={`w-full bg-transparent font-heading text-2xl uppercase ${focusRing}`}
      />
    </header>
  );
}
