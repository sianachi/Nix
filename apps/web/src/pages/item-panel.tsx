import { Icon, Segmented, focusRing } from '@nix/ui';
import { PanelRightClose } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { PropertyPanel } from '../properties/property-panel';
import type { ItemProperties } from '../properties/use-item-properties';
import type { ContainerData } from '../views/use-container';
import { SchemaEditor } from '../views/schema-editor';
import { ViewEditor } from '../views/view-editor';

/**
 * One panel, three panes: what this item *is*, what its children may carry, and how they are shown.
 *
 * **The rename is the point.** Two surfaces were called Properties - the values on this item, and
 * the schema it gives its children - and they are different questions with the same answer only by
 * accident. "Details" is what this one holds. "Fields" is what the things inside it may hold.
 *
 * It replaces two ghost buttons that opened modals. A dialog is the wrong shape for configuring a
 * view: it covers the view you are configuring, so every change means closing it to look and
 * reopening it to continue.
 */

export type Pane = 'details' | 'fields' | 'views';

const PANES = [
  { value: 'details', label: 'Details' },
  { value: 'fields', label: 'Fields' },
  { value: 'views', label: 'Views' },
] as const;

export interface ItemPanelProps {
  readonly container: ContainerData;

  /** This item's own property values, from `useItemProperties`. */
  readonly details: ItemProperties;

  readonly onClose: () => void;
}

export function ItemPanel({ container, details, onClose }: ItemPanelProps): ReactNode {
  const [pane, setPane] = useState<Pane>('details');

  return (
    // The panel clips and the pane content inside it scrolls, rather than the panel itself
    // scrolling. With the scroller on the aside, the pane switcher and the only control that closes
    // the panel scrolled away with the fields - so on a container with a long schema you could edit
    // your way to a position with no visible way back. The workspace tree is built the same way,
    // for the same reason.
    <aside
      aria-label="Item settings"
      className="flex w-[340px] shrink-0 flex-col overflow-hidden bg-surface"
    >
      <div className="flex shrink-0 items-center gap-2 px-3 py-3">
        <Segmented
          label="What to configure"
          options={PANES}
          value={pane}
          onChange={setPane}
          className="min-w-0 flex-1"
        />

        <button
          type="button"
          aria-label="Hide the settings panel"
          onClick={onClose}
          className={`flex size-7 shrink-0 items-center justify-center rounded-sm text-muted hover:bg-foreground/7 hover:text-foreground ${focusRing}`}
        >
          <Icon icon={PanelRightClose} size="sm" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pb-3">
        {pane === 'details' ? (
          <DetailsPane container={container} details={details} />
        ) : pane === 'fields' ? (
          // Both editors render inline now rather than as modals. `open` stays in their contract
          // because it is what re-seeds their draft, and a pane that is not showing is closed as
          // far as they are concerned.
          <SchemaEditor container={container} open onClose={onClose} inline />
        ) : (
          <ViewEditor container={container} open onClose={onClose} inline />
        )}
      </div>
    </aside>
  );
}

/**
 * This item's own values.
 *
 * Says nothing rather than apologising when there is no schema: a panel reading "no properties" on
 * every note would be a permanent notice about a situation that is normal.
 */
function DetailsPane({
  container,
  details,
}: {
  readonly container: ContainerData;
  readonly details: ItemPanelProps['details'];
}): ReactNode {
  const properties = container.schema?.properties ?? [];

  if (details.item === null) {
    return <p className="text-sm text-muted">Loading this item&rsquo;s details…</p>;
  }

  if (!details.loading && properties.length === 0) {
    return (
      <p className="text-sm text-muted">
        Nothing carries properties here yet. Add one under Fields and it appears on every item
        inside this one.
      </p>
    );
  }

  return (
    <PropertyPanel
      item={details.item}
      properties={properties}
      loading={details.loading}
      onChange={details.write}
    />
  );
}
