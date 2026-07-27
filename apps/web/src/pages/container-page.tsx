import { Button, Icon } from '@nix/ui';
import { Settings2, TriangleAlert } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';

import { BoardView } from '../views/board-view';
import { CalendarView } from '../views/calendar-view';
import { isKnownViewKind, type View } from '../views/container-model';
import { ListView } from '../views/list-view';
import { useContainer } from '../views/use-container';
import { SchemaEditor } from '../views/schema-editor';
import { ViewEditor } from '../views/view-editor';
import { useViewState } from '../views/view-state';
import { ViewSwitcher } from '../views/view-switcher';

/**
 * A container, looked at through one of its views.
 *
 * **This is what "a board is a way of looking at a folder" means in code.** One screen renders a
 * container; which renderer it uses is the container's configuration plus the URL, and switching
 * does not navigate anywhere - the same folder is still open.
 *
 * The three renderers are interchangeable by construction: each takes the container's data, its
 * view definition, and a way to open an item. Adding a fourth is a case in one switch and a
 * component, which is the property that makes the canvas a plausible fourth later without
 * rewriting this.
 */

export interface ContainerPageProps {
  readonly containerId: string;
  readonly onOpen: (itemId: string) => void;
}

export function ContainerPage({ containerId, onOpen }: ContainerPageProps): ReactNode {
  const container = useContainer(containerId);
  const { viewId, selectView } = useViewState();
  const [editing, setEditing] = useState<'schema' | 'views' | null>(null);

  // Memoised so the fallback array is not a new identity on every render, which would make the
  // active-view lookup below recompute for no reason.
  const views = useMemo(() => container.views?.views ?? [], [container.views]);
  const unrenderable = container.views?.unrenderable ?? [];

  // The URL names the view; the container's first is the fallback. The URL wins because it is the
  // more specific statement - somebody chose it, possibly in a link they were handed - and the
  // stored set is the starting point rather than the authority.
  const active = useMemo<View | null>(() => {
    if (views.length === 0) {
      return null;
    }

    return views.find((view) => view.id === viewId) ?? views[0] ?? null;
  }, [viewId, views]);

  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label="Container">
      <div className="flex items-center border-b border-divider">
        <div className="min-w-0 flex-1">
          <ViewSwitcher
            views={views}
            unrenderable={unrenderable}
            activeViewId={active?.id ?? null}
            onSelect={selectView}
          />
        </div>

        {/* Both editors live here rather than in a settings page, because they are configuration of
            this folder and nothing else. A person who wants a board wants it for the folder they
            are looking at, and sending them elsewhere to say so loses their place. */}
        <div className="flex shrink-0 items-center gap-1 px-2">
          <Button
            variant="ghost"
            className="px-2 py-1 text-[11px]"
            onClick={() => {
              setEditing('schema');
            }}
          >
            <Icon icon={Settings2} size="sm" />
            Properties
          </Button>

          <Button
            variant="ghost"
            className="px-2 py-1 text-[11px]"
            onClick={() => {
              setEditing('views');
            }}
          >
            Views
          </Button>
        </div>
      </div>

      <SchemaEditor
        container={container}
        open={editing === 'schema'}
        onClose={() => {
          setEditing(null);
        }}
      />

      <ViewEditor
        container={container}
        open={editing === 'views'}
        onClose={() => {
          setEditing(null);
        }}
      />

      {/* A write the server refused. Shown at the top of the container rather than on the card,
          because the card has already snapped back to where it was and the person needs to know
          why rather than watch it move. */}
      {container.writeError === null ? null : (
        <p
          role="alert"
          className="flex items-center gap-2 border-b border-divider px-4 py-2 text-[12px] text-foreground"
        >
          <Icon icon={TriangleAlert} size="sm" />
          {container.writeError}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-auto">{renderView()}</div>
    </section>
  );

  function renderView(): ReactNode {
    // No views configured at all is not a broken state: it is every container that nobody has set
    // one up on, which is most of them. A list is the sensible default because it needs no
    // configuration - it has titles to show even with no schema.
    if (active === null) {
      return <ListView container={container} view={null} onOpen={onOpen} />;
    }

    if (!isKnownViewKind(active.kind)) {
      return (
        <ViewProblem
          title="This build cannot render that view"
          detail={`"${active.name}" is a ${active.kind} view, which this version of Nix does not know how to draw. It has not been changed or removed.`}
        />
      );
    }

    switch (active.kind) {
      case 'board':
        return <BoardView container={container} view={active} onOpen={onOpen} />;
      case 'calendar':
        return <CalendarView container={container} view={active} onOpen={onOpen} />;
      default:
        return <ListView container={container} view={active} onOpen={onOpen} />;
    }
  }
}

/**
 * A view that cannot be drawn, explained.
 *
 * Every one of these says what is wrong and, where it applies, that nothing has been lost. A view
 * that simply rendered nothing would be indistinguishable from an empty folder, and the person
 * would go looking for their missing items rather than the missing configuration.
 */
function ViewProblem({
  title,
  detail,
}: {
  readonly title: string;
  readonly detail: string;
}): ReactNode {
  return (
    <div role="alert" className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <Icon icon={TriangleAlert} size="md" />
      <p className="font-heading text-[15px] uppercase tracking-[0.06em]">{title}</p>
      <p className="max-w-sm text-[13px] text-neutral-700">{detail}</p>
    </div>
  );
}
