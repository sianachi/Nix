import type { ReactNode } from 'react';

import { ErrorPanel } from '../../components/states/status-panels';
import type { View } from './container-model';
import { ListView } from '../list/list-view';
import type { ContainerData } from './use-container';
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

/**
 * The gutter a view's content is inset by, matching ItemHeader and ViewSwitcher (editor-page.tsx,
 * view-switcher.tsx).
 *
 * A view's own content - board, gallery, list, calendar, timeline - carries no horizontal padding
 * of its own, so without the wrapper below its grid or table started flush with the pane's edge, a
 * further two steps left of where the switcher's tabs and the header's title both start. One
 * wrapper rather than the same padding repeated in five view files, which is what let it drift the
 * first time (see the follow-up note in rhythm-specimen.tsx's chrome-alignment demo).
 *
 * **Exported as a constant, not described in prose.** The wrapper removed the repetition and a
 * comment saying "px-8" was the only thing tying the one remaining exception - the calendar's
 * bleeding scroller - back to it, which is the same drift in slower motion. A whole class string
 * rather than an assembled one, because Tailwind generates only what it can read in the source.
 */
export const VIEW_GUTTER = 'px-8';

/**
 * The gutter, cancelled and then re-applied inside.
 *
 * For content that must scroll edge to edge of the pane while its own padding keeps the resting
 * layout identical - the calendar's wide grid is the one case. Paired with {@link VIEW_GUTTER} so
 * the negative margin can never be a different number from the padding it undoes.
 */
export const VIEW_GUTTER_BLEED = '-mx-8 px-8';

export function ContainerView({ container, view, onOpen }: ContainerViewProps): ReactNode {
  return <div className={VIEW_GUTTER}>{renderContent(container, view, onOpen)}</div>;
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
