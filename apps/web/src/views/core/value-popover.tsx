import { Popover, Text, cn, focusRing } from '@nix/ui';
import type { ReactNode } from 'react';

import {
  PropertyValueDisplay,
  hasDisplayValue,
  type ValueDensity,
} from '../../properties/property-value-display';
import type { PropertyDefinition, PropertyOwner } from './container-model';

/**
 * One property value on a compact face (a phone row, a gallery card), read-only until tapped.
 * The tap opens the cell's own editor, passed as children, in a popover - so a face is never a
 * form, and there is one edit path. The button is named "<Field> for <Title>" so a screen reader
 * can tell twenty cards' "Category" values apart. An empty value shows the field's name, muted,
 * so it can still be filled in from here; `labelled` puts that name before a filled value too, for
 * faces with no column header to say which field a bare "Ada" belongs to (a card).
 */
export function ValuePopover(props: {
  readonly item: PropertyOwner;
  readonly property: PropertyDefinition;
  readonly density: ValueDensity;
  readonly className?: string;
  readonly labelled?: boolean;
  readonly children: ReactNode;
}): ReactNode {
  const { item, property, density, className, labelled = false, children } = props;
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
          {/* Spoken first, so a screen reader hears "Status for Plan, Done" rather than the value alone. */}
          <span className="sr-only">{hasDisplayValue(item, property) ? `${label}, ` : label}</span>
          {hasDisplayValue(item, property) ? (
            <>
              {labelled ? (
                <span aria-hidden className="mr-2 shrink-0">
                  <Text as="span" variant="caption" tone="muted">
                    {property.label}
                  </Text>
                </span>
              ) : null}
              <PropertyValueDisplay item={item} property={property} density={density} />
            </>
          ) : (
            // Text does not forward aria-hidden, so the muted name is hidden by its wrapper.
            <span aria-hidden className="min-w-0">
              <Text as="span" variant="caption" tone="muted" truncate>
                {property.label}
              </Text>
            </span>
          )}
        </button>
      )}
    >
      {/* The panel is a DOM child of a card or row that has a long-press menu: without this, holding
          a finger in the editor would open that menu instead of selecting text. */}
      <div data-context-menu-ignore>{children}</div>
    </Popover>
  );
}
