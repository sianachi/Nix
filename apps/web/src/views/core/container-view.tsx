import { useEffect, useState, type ReactNode } from 'react';
import { Button, Text } from '@nix/ui';
import { useNarrowViewport, useRoomForAnotherPane } from '../../layout/viewport';
import { useOptionalItemCommands } from '../../items/item-commands-context';
import { useItemDialog } from '../../items/item-dialog-context';

import { EmptyPanel, ErrorPanel } from '../../components/states/status-panels';
import type { View } from './container-model';
import { ListView } from '../list/list-view';
import type { ContainerData } from './use-container';
import { VIEW_GUTTER } from './view-gutter';
import { ItemSelectionContext } from './item-selection-context';
import { resolveOpenMode } from './open-policy';
import { SelectionBar } from './selection-bar';
import { useItemSelection } from './use-item-selection';
import { capabilitiesOf, DRAG_EFFECT_COPY } from './view-capabilities';
import { findViewKind } from './view-kinds';
import { ViewItemVisibility } from './view-item-visibility';
import { ViewTools } from './view-tools';
import { useViewState } from './view-state';

/**
 * An item's children, drawn the way the chosen view says.
 *
 * Only the contents. The switcher, the configuration buttons and the item's own heading belong to
 * the screen around this, because that screen also has to offer the item's *body* - and a control
 * that chose between the body and a view could not live inside the thing it chooses.
 */

export interface ContainerViewProps {
  readonly container: ContainerData;

  /** The chosen view, or null when the item offers none. */
  readonly view: View | null;

  readonly onOpen: (itemId: string) => void;

  /** Opens in another pane, when the screen around this view offers one. */
  readonly onOpenBeside?: ((itemId: string) => void) | undefined;
}

export function ContainerView({
  container,
  view,
  onOpen,
  onOpenBeside,
}: ContainerViewProps): ReactNode {
  const openDialog = useItemDialog();
  const narrow = useNarrowViewport();
  const roomForPane = useRoomForAnotherPane();
  // One policy decides how an activated row opens; see open-policy.ts.
  const mode = resolveOpenMode({
    view,
    narrow,
    canOpenBeside: roomForPane && onOpenBeside !== undefined,
  });
  const open =
    mode === 'beside' && onOpenBeside !== undefined
      ? onOpenBeside
      : mode === 'dialog'
        ? (openDialog ?? onOpen)
        : onOpen;
  const [grid, setGrid] = useState(false);
  const viewState = useViewState();
  const descriptor = view === null ? null : findViewKind(view.kind);

  // One selection for whatever the view draws (requirement 7). Rows that leave the container -
  // moved, deleted, filtered by somebody else - leave the selection with them.
  const capabilities = capabilitiesOf(view?.kind ?? 'list');
  const selection = useItemSelection();
  const commands = useOptionalItemCommands();
  const childIds = container.children.map((child) => child.id);
  const childKey = childIds.join('\u0000');
  useEffect(() => {
    selection.prune(childKey.length === 0 ? [] : childKey.split('\u0000'));
    // `prune` is stable; the join is what changes when the children do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [childKey]);
  const selecting = capabilities.select && !container.locked;
  const selectionBar = selecting ? (
    <SelectionBar
      count={selection.selected.size}
      onMove={
        commands === null || !capabilities.move
          ? undefined
          : () => {
              commands.moveItems([...selection.selected]);
            }
      }
      onClear={selection.clear}
    />
  ) : null;
  // What a drop does here, said before it happens rather than discovered afterwards.
  const dragHint =
    capabilities.drag === null || container.locked ? null : (
      <Text as="p" variant="caption" tone="muted">
        {DRAG_EFFECT_COPY[capabilities.drag]}
      </Text>
    );
  const selectionValue = { selected: selection.selected, toggle: selection.toggle, capabilities };
  const tools =
    container.status === 'ready' &&
    !container.locked &&
    (view === null || descriptor?.appliesSavedFilters === true || view.kind === 'query') ? (
      <ViewTools
        key={`${container.itemId ?? 'root'}:${view?.id ?? 'default'}`}
        view={view}
        schema={container.schema?.properties ?? []}
        viewState={viewState}
        onSave={async (filters) => {
          const stored = container.views?.views ?? [];
          if (view === null || !stored.some((candidate) => candidate.id === view.id)) {
            return 'This view is no longer available. Reload it before saving filters.';
          }
          return container.setViews(
            stored.map((candidate) =>
              candidate.id === view.id ? { ...candidate, filters: [...filters] } : candidate,
            ),
          );
        }}
      />
    ) : null;
  if (narrow && view?.kind === 'sheet')
    return (
      <div className={VIEW_GUTTER}>
        {tools}
        <Button
          variant="ghost"
          aria-pressed={grid}
          onClick={() => {
            setGrid(!grid);
          }}
        >
          {grid ? 'Browse records' : 'Show spreadsheet grid'}
        </Button>
        {grid ? (
          <ViewItemVisibility container={container} view={view}>
            {(visible) => renderContent(visible, view, open)}
          </ViewItemVisibility>
        ) : (
          <ViewItemVisibility container={container} view={view}>
            {(visible) => <ListView container={visible} view={view} onOpen={open} />}
          </ViewItemVisibility>
        )}
      </div>
    );
  return (
    <ItemSelectionContext value={selecting ? selectionValue : null}>
      <div className={VIEW_GUTTER}>
        {tools}
        {dragHint}
        {selectionBar}
        <ViewItemVisibility container={container} view={view}>
          {(visible) => renderContent(visible, view, open)}
        </ViewItemVisibility>
      </div>
    </ItemSelectionContext>
  );
}

function renderContent(
  container: ContainerData,
  view: View | null,
  onOpen: (itemId: string) => void,
): ReactNode {
  // Before any view: a lock withholds the children every view draws from, and a view drawn over
  // nothing would read as an empty item.
  if (container.locked) {
    return (
      <EmptyPanel
        title="This is locked"
        detail="What is inside is hidden until you unlock it with its password."
      />
    );
  }

  // No views configured at all is not a broken state: it is every item nobody has set one up on,
  // which is most of them. A list is the sensible default because it needs no configuration - it
  // has titles to show even with no schema.
  if (view === null) {
    return <ListView container={container} view={null} onOpen={onOpen} />;
  }

  // The registry decides, rather than a switch with a default arm. That arm used to catch 'list'
  // and therefore also caught anything new, so a kind added to the type but not to the dispatch
  // rendered as a list and looked like it had worked.
  const descriptor = findViewKind(view.kind);

  if (descriptor === null) {
    // The shared error panel rather than a local shape of this file's own. A view that cannot be
    // drawn is the same fact whether the kind is unknown to this build or the configuration has
    // drifted, and the two used to be drawn differently for no reason but where they were written.
    return (
      <ErrorPanel
        title="This build cannot render that view"
        detail={`"${view.name}" is a ${view.kind} view, which this version of Nix does not know how to draw. It has not been changed or removed.`}
      />
    );
  }

  return descriptor.render({ container, view, onOpen });
}
