import { Popover, Text, cn, focusRing } from '@nix/ui';
import type { ReactNode } from 'react';

import {
  PropertyValueDisplay,
  hasDisplayValue,
  type ValueDensity,
} from '../../properties/property-value-display';
import type { Item, PropertyDefinition } from './container-model';

/**
 * One property value on a compact face (a phone row, a gallery card), read-only until tapped.
 * The tap opens the cell's own editor, passed as children, in a popover - so a face is never a
 * form, and there is one edit path. The button is named "<Field> for <Title>" so a screen reader
 * can tell twenty cards' "Category" values apart. An empty value shows the field's name, muted,
 * so it can still be filled in from here.
 */
export function ValuePopover(props: {
  readonly item: Item;
  readonly property: PropertyDefinition;
  readonly density: ValueDensity;
  readonly className?: string;
  readonly children: ReactNode;
}): ReactNode {
  const { item, property, density, className, children } = props;
  const label = `${property.label} for ${item.title || 'Untitled'}`;

  return (
    <Popover
      label={label}
      trigger={(trigger) => (
        <button
          {...trigger}
          className={cn(
            'flex min-h-(--control-md) min-w-0 cursor-default items-center rounded-md px-2 text-left pointer-coarse:min-h-(--control-lg)',
            focusRing,
            className,
          )}
        >
          {hasDisplayValue(item, property) ? (
            <PropertyValueDisplay item={item} property={property} density={density} />
          ) : (
            <Text as="span" variant="caption" tone="muted" truncate aria-hidden>
              {property.label}
            </Text>
          )}
          <span className="sr-only">{label}</span>
        </button>
      )}
    >
      {/* The panel is a DOM child of a card or row that has a long-press menu: without this, holding
          a finger in the editor would open that menu instead of selecting text. */}
      <div data-context-menu-ignore>{children}</div>
    </Popover>
  );
}
