import { Table, cn, focusRing, type TableColumn, type TableSort } from '@nix/ui';
import { type ReactNode } from 'react';

import { isKnownPropertyType } from '../../properties/property-input';
import { TITLE_COLUMN_KEY, resolveConfiguredColumns } from '../core/columns';
import {
  readPropertyText,
  type EffectiveSchema,
  type Item,
  type PropertyDefinition,
  type PropertyValue,
  type View,
} from '../core/container-model';
import { CreateItemControl } from '../core/create-item-control';
import { ListCell } from './list-cell';
import type { ContainerData } from '../core/use-container';
import { drawable, resolveViewChrome } from '../core/view-chrome';
import { useViewState, type SortDirection } from '../core/view-state';

/**
 * The list view: a container's children as a table, edited in place.
 *
 * The plainest of the three views and the one every container falls back to, so it is also the one
 * that has to be right about the least interesting things - what the columns are, what order the
 * rows are in, and above all what it says when there are no rows. Those five answers are not
 * decided here: they are the shared view chrome, which the board and the calendar also ask, because
 * four copies of one decision is four chances to drop the branch nobody meets while building.
 *
 * **Every cell is a control, always drawn as one.** Not click-to-edit: that needs a focus transfer
 * effect of its own, and it hides from a screen reader the one fact the table is trying to convey,
 * which is that these values can be changed. The cost is a tab stop per cell, which a following
 * goal buys back with arrow-key navigation.
 *
 * **Plain table semantics.** A real `<table>` with `<th scope="row">` row headers, not `role="grid"`
 * with a roving tabindex. A roving tabindex is focus state with no source - it cannot come from the
 * URL - so it would be local state plus an effect moving DOM focus, and focus jumping on a re-sort,
 * on an optimistic update or on a refusal rollback is worse than a long tab order.
 *
 * **The sort is not held here.** It lives in the URL, because a sorted table that cannot be linked
 * or restored by the back button is a table somebody has to re-sort every time they arrive. This
 * component reads the sort out of `useViewState` and writes a header click back to it; between
 * those two the state is the address bar's, and React re-renders because the address changed.
 */

export interface ListViewProps {
  readonly container: ContainerData;

  /** The view being rendered, or null for a container that defines none. */
  readonly view: View | null;

  /**
   * Opens one item. A callback rather than a router import: which route an item opens at is the
   * hosting page's business, and a view that navigated on its own could not be put in a dialog, a
   * split pane, or a story.
   */
  readonly onOpen: (itemId: string) => void;
}

export function ListView(props: ListViewProps): ReactNode {
  const { container, view, onOpen } = props;
  const viewState = useViewState();

  // The URL wins, the stored view is the starting point. A view configured to sort by owner is
  // what somebody arriving with no sort in the address should see; the moment they click a header
  // the address is the more specific statement and this falls through to it.
  const sortBy = viewState.sortBy ?? view?.sortBy ?? null;
  const direction: SortDirection =
    viewState.sortBy !== null
      ? viewState.direction
      : view?.sortDescending === true
        ? 'descending'
        : 'ascending';

  const chrome = resolveViewChrome({
    container,
    viewState,
    subject: 'this list',
    // A list needs nothing configured to be drawable: it has titles to show even with no schema,
    // which is exactly why it is what every container falls back to.
    drawable: drawable(null),
    emptyTitle: 'Nothing in here yet',
    emptyDetail: 'Items added to this one appear here as rows.',
    emptyAction: <CreateItemControl label="Add an item" onCreate={container.create} />,
    filtered: (total) => ({
      title: 'No items match the filters',
      // Says how many are hidden, because "no items match" leaves open the possibility that the
      // item was empty all along, and the count is the proof that it was not.
      detail: hiddenByFilters(total),
    }),
    sortBy,
    descending: direction === 'descending',
  });

  if (chrome.kind === 'chrome') {
    return chrome.node;
  }

  function write(itemId: string, key: string, value: PropertyValue): Promise<string | null> {
    return container.setProperties(itemId, { [key]: value });
  }

  return (
    // The table's own horizontal scroller. A `w-full` table is laid out `auto`, so it cannot render
    // narrower than its min-content width - enough property columns and it paints straight past a
    // `min-w-0` parent. Now that the pane scrolls only vertically, this is the sole owner of the
    // wide axis.
    <div className="min-w-0 overflow-x-auto">
      {chrome.notice}

      <Table<Item>
        caption="Items in this one"
        columns={buildColumns(view, container.schema, onOpen, write)}
        rows={chrome.items}
        rowKey={(item) => item.id}
        // Never reached: the chrome above answers loading, empty and filtered-to-nothing before
        // this renders, so the table only ever receives rows. Required by the prop, and worded so
        // that it would still be true rather than alarming if it ever showed.
        emptyMessage="Nothing in here yet."
        {...(sortBy === null ? {} : { sort: { columnKey: sortBy, direction } })}
        onSortChange={(next: TableSort) => {
          // The table decides *what* the click asked for - reverse this column, start any other
          // ascending - and this decides where that lives. Replacing rather than pushing, so a
          // walk down a column of headers does not have to be walked back up.
          viewState.setSort(next.columnKey, next.direction);
        }}
      />

      {/* Below the table rather than as a last row. `<Table>` has no footer seam, and a row would
          enter the row-header inventory that eleven assertions compare against exactly - so it
          would be a create affordance that broke tests about columns. */}
      <CreateItemControl label="Add an item" onCreate={container.create} className="mt-2" />
    </div>
  );
}

/**
 * What the list says when the filters have removed everything.
 *
 * Says how many are hidden, because "no items match" leaves open the possibility that the item was
 * empty all along, and the count is the proof that it was not.
 */
function hiddenByFilters(total: number): string {
  return total === 1
    ? 'The one item in here is hidden by the current filters.'
    : `All ${String(total)} items in here are hidden by the current filters.`;
}

/**
 * The columns, in order: the title first, then the properties.
 *
 * The title leads unconditionally and is the row header, because it is how a person names the row
 * and how a screen reader announces which row a cell belongs to. A view that lists its own columns
 * is choosing which *properties* to show and in what order - it is not choosing whether the row
 * says what it is - so a `title` entry in that list is dropped rather than rendered twice.
 *
 * A configured column whose property is not in the schema still gets a column, headed by its key.
 * The alternative is dropping it silently, which turns a renamed property into a column that
 * vanished for no stated reason; a column of blanks under an unfamiliar heading at least says
 * where to look.
 */
function buildColumns(
  view: View | null,
  schema: EffectiveSchema | null,
  onOpen: (itemId: string) => void,
  write: (itemId: string, key: string, value: PropertyValue) => Promise<string | null>,
): readonly TableColumn<Item>[] {
  const { keys, definitions } = resolveConfiguredColumns(view, schema);

  return [
    {
      key: TITLE_COLUMN_KEY,
      header: 'Title',
      rowHeader: true,
      sortable: true,
      cell: (item) => (
        // Read-only, unlike every other column, and deliberately: renaming an item goes through the
        // tree rather than through a property write, and the row header has to stay the row's
        // primary affordance - a text box here would put an edit where a person expects a link.
        //
        // A button in the cell rather than a click handler on the row: a clickable <tr> cannot be
        // reached by a keyboard and announces nothing to a screen reader, so the affordance goes
        // on the one thing in the row that already names the destination.
        <button
          type="button"
          onClick={() => {
            onOpen(item.id);
          }}
          className={cn('cursor-pointer text-left hover:text-accent-text', focusRing)}
        >
          {item.title.length > 0 ? item.title : 'Untitled'}
        </button>
      ),
    },
    ...keys.map((key): TableColumn<Item> => {
      const definition = definitions.get(key);

      return {
        key,
        header: definition?.label ?? key,
        sortable: true,
        cell: (item) => renderProperty(item, key, definition, write),

        // Numbers read right-aligned so their digits line up; everything else keeps the table's
        // own default rather than restating it.
        ...(definition?.type === 'number' ? { align: 'end' as const } : {}),
      };
    }),
  ];
}

/**
 * One property cell: a control where this build knows the property type, and the stored value where
 * it does not.
 *
 * The unknown case reads rather than edits, and it renders as bare text rather than through the
 * read-only floor `PropertyInput` falls back to. That floor explains itself in a sentence, and a
 * sentence inside a table cell becomes part of the cell's accessible name - so the cell holding
 * "four of five" would announce a paragraph about property types instead of the value.
 *
 * A column the schema does not describe at all has no type to dispatch on and no label to name a
 * control with, so it reads too.
 */
function renderProperty(
  item: Item,
  key: string,
  definition: PropertyDefinition | undefined,
  write: (itemId: string, key: string, value: PropertyValue) => Promise<string | null>,
): ReactNode {
  if (definition === undefined || !isKnownPropertyType(definition.type)) {
    return readPropertyText(item, key);
  }

  return (
    <ListCell item={item} property={definition} onWrite={(value) => write(item.id, key, value)} />
  );
}
