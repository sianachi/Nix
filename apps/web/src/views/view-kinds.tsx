import { Columns3, LayoutList, CalendarDays } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { BoardView } from './board-view';
import { CalendarView } from './calendar-view';
import type { PropertyDefinition, View } from './container-model';
import { ListView } from './list-view';
import type { ContainerData } from './use-container';

/**
 * Every kind of view this build can draw, and everything it knows about each one.
 *
 * **Adding a view kind is one entry in this table.** It used to be four edits that could not be
 * type-checked against each other - the kind list, an icon record, the editor's dropdown with its
 * hand-written configuration block, and a dispatch switch whose `default` case silently caught
 * anything new and drew it as a list. A kind added to three of those four compiled and shipped
 * looking like a list.
 *
 * The backend has the matching table in `Nix.Core/Views/ViewDefinition.cs`. The two are deliberately
 * separate: the server decides what is *storable* (a board must name a property to group by) and
 * this decides what is *drawable*. They agree on the stored names and nothing else, which is why an
 * older build meeting a newer build's view says it cannot draw it rather than crashing.
 */

/**
 * What every renderer is handed.
 *
 * The three renderers were structurally similar and had no shared type, so nothing checked that a
 * fourth would fit. `view` is non-nullable here: the unconfigured case is not a kind and is handled
 * once, by the caller, rather than by every renderer accepting a null it mostly ignores.
 */
export interface ViewRendererProps {
  readonly container: ContainerData;
  readonly view: View;
  readonly onOpen: (itemId: string) => void;
}

/**
 * The one property a kind needs before it can draw, and which properties will serve.
 *
 * A list has none - with no columns configured it falls back to the effective schema, and with no
 * schema at all it still has titles to show - which is why this is nullable on the descriptor
 * rather than every kind carrying an empty one.
 */
export interface ViewConfiguration {
  /** The field on the view that names the property. */
  readonly field: 'groupBy' | 'dateProperty';

  readonly label: string;

  /** Said when the schema offers nothing this kind can use. */
  readonly emptyHint: string;

  /** Said when it does. */
  readonly hint: string;

  /** Which declared properties may be chosen. */
  readonly accepts: (property: PropertyDefinition) => boolean;

  /**
   * Fields that stop meaning anything when the chosen property changes.
   *
   * A board's column order belonged to the old property; carried across, it would filter the new
   * one down to values it does not have.
   */
  readonly clears?: Partial<View>;
}

export interface ViewKindDescriptor {
  /** The name this kind is stored and published under. */
  readonly kind: string;

  /** What a person sees in the switcher and the editor. */
  readonly label: string;

  readonly icon: LucideIcon;

  readonly render: (props: ViewRendererProps) => ReactNode;

  readonly configures: ViewConfiguration | null;
}

export const VIEW_KINDS: readonly ViewKindDescriptor[] = [
  {
    kind: 'list',
    label: 'List',
    icon: LayoutList,
    render: (props) => <ListView {...props} />,
    configures: null,
  },
  {
    kind: 'board',
    label: 'Board',
    icon: Columns3,
    render: (props) => <BoardView {...props} />,
    configures: {
      field: 'groupBy',
      label: 'Group by',
      emptyHint: 'There is no select property yet. Add one under Properties first.',
      hint: 'Only a select property can become columns.',
      accepts: (property) => property.type === 'select',
      clears: { groupOrder: [] },
    },
  },
  {
    kind: 'calendar',
    label: 'Calendar',
    icon: CalendarDays,
    render: (props) => <CalendarView {...props} />,
    configures: {
      field: 'dateProperty',
      label: 'Place by',
      emptyHint: 'There is no date property yet. Add one under Properties first.',
      hint: 'Items appear on the day this property names.',
      accepts: (property) => property.type === 'date',
    },
  },
];

/**
 * What this build knows about a kind, or nothing at all.
 *
 * Returning null rather than a fallback is the whole fail-closed behaviour: a view written by a
 * newer build is reported as undrawable and left untouched, never quietly rendered as something
 * else. The `default` case this replaces did exactly that.
 */
export function findViewKind(kind: string): ViewKindDescriptor | null {
  return VIEW_KINDS.find((descriptor) => descriptor.kind === kind) ?? null;
}

/** Whether this build can draw a kind. */
export function isKnownViewKind(kind: string): boolean {
  return findViewKind(kind) !== null;
}
