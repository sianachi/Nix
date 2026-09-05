import { useNarrowViewport } from '../../layout/viewport';
import { Button, Text, Table, cn, focusRing, type TableColumn, type TableSort } from '@nix/ui';
import { useMemo, useRef, useState, type ReactNode } from 'react';

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
import { cellFor, isCellMoveKey, moveFocusedCell } from './cell-nav';
import { ListCell } from './list-cell';
import type { ContainerData } from '../core/use-container';
import { drawable, useViewChrome } from '../core/view-chrome';
import { useViewState, type SortDirection } from '../core/view-state';
import { useVirtualWindow } from '../core/use-virtual-window';
import { virtualSpacers } from '../core/virtual-window';

const VIRTUALIZATION_THRESHOLD = 100;
const ESTIMATED_ROW_HEIGHT = 45;

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
 * which is that these values can be changed. The cost is a tab stop per cell - kept, deliberately:
 * goal 3.8 adds Alt+Arrow cell-to-cell movement (`./cell-nav.ts`) rather than roving tabindex, so
 * this table never trades a long tab order for the focus-restoration problem a roving tabindex
 * would reopen on every re-sort, optimistic update and refusal rollback (see the note below).
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
  const narrow = useNarrowViewport();
  const viewState = useViewState();
  const [refusals, setRefusals] = useState<ReadonlyMap<string, string>>(() => new Map());

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

  const chrome = useViewChrome({
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

  const refusalStore: CellRefusalStore = {
    read: (itemId, key) => refusals.get(cellRefusalKey(itemId, key)) ?? null,
    write: (itemId, key, refusal) => {
      setRefusals((current) => {
        const next = new Map(current);
        const cacheKey = cellRefusalKey(itemId, key);
        if (refusal === null) {
          next.delete(cacheKey);
        } else {
          next.set(cacheKey, refusal);
        }
        return next;
      });
    },
  };
  const columns = buildColumns(view, container.schema, onOpen, write, refusalStore);
  const sort = sortBy === null ? undefined : { columnKey: sortBy, direction };
  const onSortChange = (next: TableSort): void => {
    viewState.setSort(next.columnKey, next.direction);
  };

  return (
    // The table's own horizontal scroller. A `w-full` table is laid out `auto`, so it cannot render
    // narrower than its min-content width - enough property columns and it paints straight past a
    // `min-w-0` parent. Now that the pane scrolls only vertically, this is the sole owner of the
    // wide axis.
    //
    // Justification: this div is not itself interactive - it only delegates a keydown listener
    // that catches Alt+Arrow bubbling up from its own focusable descendants (the real per-cell
    // controls, see `cell-nav.ts`). A role or tabIndex here would make the div itself a tab stop
    // or a widget, which is exactly what goal 3.8's ruling says not to build.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className="min-w-0 overflow-x-auto"
      onKeyDown={(event) => {
        // Alt is the gate: a plain arrow, Home or End belongs to whatever control is focused (a
        // caret, a date stepper, a select, a checkbox) and must reach it untouched - see
        // `cell-nav.ts` for why this table cannot use the spreadsheet's own arrow-key ladder.
        if (!event.altKey || event.ctrlKey || event.metaKey || !isCellMoveKey(event.key)) {
          return;
        }
        if (!(event.target instanceof Element)) {
          return;
        }
        const cell = cellFor(event.target);
        if (cell === null) {
          // Not one of the list's own cells (a sort header, the "Add an item" control): this
          // shortcut has nothing to say here, so the key is left alone rather than claimed.
          return;
        }
        // Claimed once it is known to be ours, whether or not a destination exists - an edge does
        // nothing to the table, but the keystroke must still not fall through to the browser's own
        // Alt+Arrow history navigation or a native `<select>`'s Alt+ArrowDown.
        event.preventDefault();
        moveFocusedCell(cell, event.key);
      }}
    >
      {chrome.notice}

      {narrow ? (
        <MobileListRows
          items={chrome.items}
          columns={columns}
          sort={sort}
          onSortChange={onSortChange}
        />
      ) : (
        <ListRows items={chrome.items} columns={columns} sort={sort} onSortChange={onSortChange} />
      )}

      {/* Below the table rather than as a last row. `<Table>` has no footer seam, and a row would
          enter the row-header inventory that eleven assertions compare against exactly - so it
          would be a create affordance that broke tests about columns. */}
      <CreateItemControl label="Add an item" onCreate={container.create} className="mt-2" />
    </div>
  );
}

interface ListRowsProps {
  readonly items: readonly Item[];
  readonly columns: readonly TableColumn<Item>[];
  readonly sort: TableSort | undefined;
  readonly onSortChange: (sort: TableSort) => void;
}

function ListRows(props: ListRowsProps): ReactNode {
  const { items, columns, sort, onSortChange } = props;
  if (items.length <= VIRTUALIZATION_THRESHOLD) {
    return (
      <Table<Item>
        caption="Items in this one"
        columns={columns}
        rows={items}
        rowKey={(item) => item.id}
        emptyMessage="Nothing in here yet."
        {...(sort === undefined ? {} : { sort })}
        onSortChange={onSortChange}
      />
    );
  }

  return (
    <VirtualListRows items={items} columns={columns} sort={sort} onSortChange={onSortChange} />
  );
}

function VirtualListRows(props: ListRowsProps): ReactNode {
  const { items, columns, sort, onSortChange } = props;
  const rootRef = useRef<HTMLTableElement>(null);
  // Stable identity keeps the virtualizer's measurement subscriptions intact between renders.
  const keys = useMemo(() => items.map((item) => item.id), [items]);
  const windowed = useVirtualWindow({
    keys,
    rootRef,
    estimate: ESTIMATED_ROW_HEIGHT,
  });
  const rows = windowed.indexes.flatMap((index) => {
    const item = items[index];
    return item === undefined ? [] : [item];
  });

  return (
    <Table<Item>
      tableRef={rootRef}
      caption="Items in this one"
      columns={columns}
      rows={rows}
      rowKey={(item) => item.id}
      emptyMessage="Nothing in here yet."
      {...(sort === undefined ? {} : { sort })}
      onSortChange={onSortChange}
      virtualization={{
        totalRows: items.length,
        rowIndexes: windowed.indexes,
        spacerHeights: virtualSpacers(windowed.offsets, windowed.indexes),
      }}
    />
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
  refusals: CellRefusalStore,
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
        cell: (item) => renderProperty(item, key, definition, write, refusals),

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
  refusals: CellRefusalStore,
): ReactNode {
  if (definition === undefined || !isKnownPropertyType(definition.type)) {
    return readPropertyText(item, key);
  }

  return (
    <ListCell
      item={item}
      property={definition}
      onWrite={(value) => write(item.id, key, value)}
      refusal={refusals.read(item.id, key)}
      onRefusalChange={(refusal) => {
        refusals.write(item.id, key, refusal);
      }}
    />
  );
}

interface CellRefusalStore {
  readonly read: (itemId: string, key: string) => string | null;
  readonly write: (itemId: string, key: string, refusal: string | null) => void;
}

function cellRefusalKey(itemId: string, key: string): string {
  return `${itemId}\u0000${key}`;
}

function MobileListRows({ items, columns, sort, onSortChange }: ListRowsProps): ReactNode {
  const [limit, setLimit] = useState(40);
  return (
    <section aria-label="Items in this one" className="flex flex-col gap-3">
      <label className="flex flex-wrap items-center gap-2">
        <Text as="span" variant="caption">
          Sort by
        </Text>
        <select
          aria-label="Sort by"
          value={sort?.columnKey ?? ''}
          className="min-w-0 rounded-md border border-divider bg-background p-2"
          onChange={(event) => {
            onSortChange({
              columnKey: event.target.value,
              direction: sort?.direction ?? 'ascending',
            });
          }}
        >
          <option value="" disabled>
            Item order
          </option>
          {columns.map((column) => (
            <option key={column.key} value={column.key}>
              {column.header}
            </option>
          ))}
        </select>
        <Button
          variant="ghost"
          disabled={!sort}
          onClick={() => {
            if (sort)
              onSortChange({
                ...sort,
                direction: sort.direction === 'ascending' ? 'descending' : 'ascending',
              });
          }}
        >
          {sort?.direction === 'descending' ? 'Descending' : 'Ascending'}
        </Button>
      </label>
      <ul className="divide-y divide-divider">
        {items.slice(0, limit).map((item) => (
          <li key={item.id} className="py-3">
            <div className="py-2">{columns[0]?.cell(item)}</div>
            {columns.length > 1 ? (
              <details>
                <summary className="cursor-pointer py-2">Fields</summary>
                <dl className="flex flex-col gap-3">
                  {columns.slice(1).map((column) => (
                    <div key={column.key} className="min-w-0">
                      <dt>
                        <Text as="span" variant="caption" tone="muted">
                          {column.header}
                        </Text>
                      </dt>
                      <dd className="min-w-0 py-1">{column.cell(item)}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            ) : null}
          </li>
        ))}
      </ul>
      {items.length > limit ? (
        <Button
          variant="secondary"
          onClick={() => {
            setLimit((current) => current + 40);
          }}
        >
          Show more items
        </Button>
      ) : null}
    </section>
  );
}
