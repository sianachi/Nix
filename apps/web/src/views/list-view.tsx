import { Button, Table, Tag, Text, cn, focusRing, type TableColumn, type TableSort } from '@nix/ui';
import { type ReactNode } from 'react';

import {
  applyFilters,
  readPropertyText,
  readSelectValue,
  sortItems,
  type EffectiveSchema,
  type Item,
  type PropertyDefinition,
  type View,
} from './container-model';
import type { ContainerData } from './use-container';
import { useViewState, type SortDirection } from './view-state';

/**
 * The list view: a container's children as a table.
 *
 * The plainest of the three views and the one every container falls back to, so it is also the one
 * that has to be right about the least interesting things - what the columns are, what order the
 * rows are in, and above all what it says when there are no rows.
 *
 * **Four answers, four messages.** "We are still asking", "this item is empty", "it could
 * not be read" and "your filters are hiding everything" are four different facts, and three of them
 * are actionable in different directions. The last is the one worth spending words on: somebody who
 * followed a filtered link, or filtered down and forgot, and is told "nothing in here yet" will go
 * looking for notes they think have been deleted. So the empty message is chosen from what we know
 * - the folder had children and the filters removed all of them is not emptiness - and the state
 * carries the one control that gets out of it.
 *
 * **The sort is not held here.** It lives in the URL, because a sorted table that cannot be linked
 * or restored by the back button is a table somebody has to re-sort every time they arrive. This
 * component reads the sort out of `useViewState` and writes a header click back to it; between
 * those two the state is the address bar's, and React re-renders because the address changed.
 */

/** The title is a column like any other for sorting, and `sortItems` knows the key by name. */
const TITLE_COLUMN_KEY = 'title';

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

  const visible = applyFilters(container.children, viewState.filters);
  const rows = sortItems(visible, sortBy, direction === 'descending');

  // Emptiness we caused, rather than emptiness we found. Only claimable once the answer has
  // arrived: mid-load there is nothing to hide and nothing to say about it.
  const filteredToNothing =
    container.status === 'ready' &&
    rows.length === 0 &&
    container.children.length > 0 &&
    viewState.filters.length > 0;

  if (container.status === 'error') {
    // The table is not rendered at all rather than rendered empty. A header row over a failure
    // reads as a folder with no items in it, which is the one thing we know it is not - and the
    // columns come from a schema that did not arrive either, so they would be a guess.
    return (
      <div role="alert" className="max-w-md">
        <Text variant="bodySmall" tone="muted" className="mb-3">
          {container.error ?? 'The contents could not be loaded.'}
        </Text>
        <Button
          variant="secondary"
          onClick={() => {
            void container.reload();
          }}
        >
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <Table<Item>
        caption="Items in this one"
        columns={buildColumns(view, container.schema, onOpen)}
        rows={rows}
        rowKey={(item) => item.id}
        loading={container.status === 'loading'}
        loadingMessage="Loading the contents"
        emptyMessage={
          filteredToNothing ? hiddenByFilters(container.children.length) : 'Nothing in here yet.'
        }
        // Spread rather than passed as `undefined`: under `exactOptionalPropertyTypes` an optional
        // prop is either given or not given, and the distinction matters here - an absent `sort`
        // has the headers offer a sort rather than claim one, because the rows are then in the
        // order somebody arranged them by hand, which is not a column's doing.
        {...(sortBy === null ? {} : { sort: { columnKey: sortBy, direction } })}
        onSortChange={(next: TableSort) => {
          // The table decides *what* the click asked for - reverse this column, start any other
          // ascending - and this decides where that lives. Replacing rather than pushing, so a
          // walk down a column of headers does not have to be walked back up.
          viewState.setSort(next.columnKey, next.direction);
        }}
      />

      {filteredToNothing ? (
        // The way out. A state that explains itself and then offers nothing to do about it is only
        // half an answer, and the filters are in the URL - not somewhere this screen can point at.
        <Button
          variant="secondary"
          className="mt-3"
          onClick={() => {
            viewState.clearFilters();
          }}
        >
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}

/**
 * What the table says when the filters have removed everything.
 *
 * Says how many are hidden, because "no items match" leaves open the possibility that the item
 * was empty all along, and the count is the proof that it was not.
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
): readonly TableColumn<Item>[] {
  const definitions = new Map(
    (schema?.properties ?? []).map((definition) => [definition.key, definition]),
  );

  // The schema's declared order when the view names nothing - a Map keeps insertion order, so the
  // columns come out in the order the schema lists them rather than an order of our invention.
  const configured =
    view !== null && view.columns.length > 0 ? view.columns : [...definitions.keys()];

  return [
    {
      key: TITLE_COLUMN_KEY,
      header: 'Title',
      rowHeader: true,
      sortable: true,
      cell: (item) => (
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
    ...[...new Set(configured)]
      .filter((key) => key !== TITLE_COLUMN_KEY)
      .map((key): TableColumn<Item> => {
        const definition = definitions.get(key);

        return {
          key,
          header: definition?.label ?? key,
          sortable: true,
          cell: (item) => renderProperty(item, key, definition),

          // Numbers read right-aligned so their digits line up; everything else keeps the table's
          // own default rather than restating it.
          ...(definition?.type === 'number' ? { align: 'end' as const } : {}),
        };
      }),
  ];
}

/**
 * One property cell.
 *
 * Everything goes through `readPropertyText` unless there is a reason for it not to, which is what
 * makes a property type this build has never heard of render its value instead of an error: the
 * type only ever selects a *presentation*, and the absence of a match is a missing presentation,
 * not a missing value. A select is the one case worth drawing differently - a state reads as a
 * state at a glance - and it is drawn with the same tag the rest of the product uses.
 */
function renderProperty(
  item: Item,
  key: string,
  definition: PropertyDefinition | undefined,
): ReactNode {
  if (definition?.type === 'select') {
    const value = readSelectValue(item, key);
    return value === null ? null : <Tag>{value}</Tag>;
  }

  return readPropertyText(item, key);
}
