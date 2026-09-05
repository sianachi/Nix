import { useState, type ReactNode } from 'react';
import { Button } from '@nix/ui';
import { useNarrowViewport } from '../../layout/viewport';
import { useItemDialog } from '../../items/item-dialog-context';

import { ErrorPanel } from '../../components/states/status-panels';
import type { View } from './container-model';
import { ListView } from '../list/list-view';
import type { ContainerData } from './use-container';
import { VIEW_GUTTER } from './view-gutter';
import { findViewKind } from './view-kinds';

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
}

export function ContainerView({ container, view, onOpen }: ContainerViewProps): ReactNode {
  const openDialog = useItemDialog();
  const narrow = useNarrowViewport();
  const [grid, setGrid] = useState(false);
  if (narrow && view?.kind === 'sheet')
    return (
      <div className={VIEW_GUTTER}>
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
          renderContent(container, view, openDialog ?? onOpen)
        ) : (
          <ListView container={container} view={view} onOpen={openDialog ?? onOpen} />
        )}
      </div>
    );
  return <div className={VIEW_GUTTER}>{renderContent(container, view, openDialog ?? onOpen)}</div>;
}

function renderContent(
  container: ContainerData,
  view: View | null,
  onOpen: (itemId: string) => void,
): ReactNode {
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
