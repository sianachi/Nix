import { Popover, Text, cn, focusRing } from '@nix/ui';
import { createContext, useContext, type ReactNode } from 'react';

import {
  PropertyValueDisplay,
  hasDisplayValue,
  type ValueDensity,
} from '../../properties/property-value-display';
import type { PropertyDefinition, PropertyOwner } from './container-model';

/** Single-choice fields: picking the value is the whole edit, so the popover closes once it is stored. */
const DISCRETE_TYPES: ReadonlySet<string> = new Set([
  'select',
  'priority',
  'checkbox',
  'completion',
  'assignee',
  'date',
  'due_date',
  'start_date',
]);

const CommitStoredContext = createContext<() => void>(() => undefined);

/**
 * For the editor inside a `ValuePopover`: call this after a write was stored. It closes the popover
 * (focus back on the trigger) for single-choice fields and does nothing for text, number or
 * multi-select, which stay open until Escape, an outside click or Enter.
 */
export function useCommitStored(): () => void {
  return useContext(CommitStoredContext);
}

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
            'flex min-h-(--control-md) min-w-0 cursor-default items-center rounded-md px-2 text-left any-pointer-coarse:min-h-(--control-lg)',
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
      {({ close }) => (
        <CommitStoredContext value={DISCRETE_TYPES.has(property.type) ? close : () => undefined}>
          {/* The panel is a DOM child of a card or row that has a long-press menu: without this, holding
              a finger in the editor would open that menu instead of selecting text. */}
          <div data-context-menu-ignore>{children}</div>
        </CommitStoredContext>
      )}
    </Popover>
  );
}
