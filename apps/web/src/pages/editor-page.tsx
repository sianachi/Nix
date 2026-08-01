import { Button, Icon, focusRing } from '@nix/ui';
import { Settings2 } from 'lucide-react';
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
  const { tree, selectedId } = useOutletContext<ShellContext>();
  const { select } = useSelectedItem();
  const item = selectedId === null ? null : tree.find(selectedId);

  if (selectedId === null || item === null) {
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
      onOpen={select}
    />
  );
}

interface OpenItemProps {
  readonly tree: ShellContext['tree'];
  readonly itemId: string;
  readonly title: string;

  /** The item's `type`: how its own body is drawn. Never gates what it may contain. */
  readonly bodyKind: string;
  readonly onOpen: (itemId: string) => void;
}

function OpenItem({ tree, itemId, title, bodyKind, onOpen }: OpenItemProps): ReactNode {
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
    <article className={paneColumn}>
      <ItemHeader tree={tree} itemId={itemId} title={title} onNavigate={onOpen} />

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
