import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { type ReactNode } from 'react';

import { cn } from '../lib/cn';
import { Icon } from '../primitives/Icon';
import { Text } from '../primitives/Text';
import { focusRing, inkWashStates } from '../primitives/interaction';

/**
 * <Table> - rows of data, with the four things a data table owes the reader.
 *
 * A caption saying what the table is, a header row saying what the columns are, an honest account
 * of what is in the body, and - where the data can be reordered - a way to say so that a keyboard
 * and a screen reader can both reach.
 *
 * **Loading and empty are different answers and are drawn differently.** "No documents" and "we
 * have not finished asking" look identical if a loading table renders an empty body, and the first
 * one is a statement of fact the reader will act on. So `loading` wins over the row count: while it
 * is set the table says it is working and marks itself `aria-busy`, and the caller's empty message
 * is only ever shown when the answer has arrived and the answer was none.
 *
 * **Sorting is controlled.** The sort lives in the URL in this application - it has to, or a sorted
 * table cannot be linked, bookmarked or restored by the back button - so the component renders the
 * sort it is given and reports the sort a click asked for. It never holds one. What it does own is
 * the *policy*: clicking the sorted column reverses it, clicking any other column starts it
 * ascending. That is a pure function of the current sort, so it belongs with the header that
 * triggers it rather than being retyped at every call site.
 *
 * The directions are ARIA's own words (`ascending`/`descending`) rather than `asc`/`desc`, so the
 * value that goes into `aria-sort` is the value the caller holds - no mapping table, and nothing to
 * get backwards.
 */

export type TableSortDirection = 'ascending' | 'descending';

export interface TableSort {
  /** The `key` of the sorted column. */
  readonly columnKey: string;
  readonly direction: TableSortDirection;
}

export interface TableColumn<Row> {
  /** Identifies the column in `sort` and as a React key. Stable across renders and reorders. */
  readonly key: string;

  /** The header's visible text. Also what a sortable header's button is named. */
  readonly header: string;

  /** Draws one cell. A function rather than a field name so a cell can be a `<Tag>` or a link. */
  readonly cell: (row: Row) => ReactNode;

  /**
   * Offers this column's header as a sort control. Ignored without `onSortChange`: a header that
   * looks clickable and does nothing is worse than a header that never offered.
   */
  readonly sortable?: boolean;

  /**
   * Renders this column's cell as `<th scope="row">` rather than `<td>`, so a screen reader
   * announces which row a cell belongs to as it moves across. At most one column should claim it -
   * the one a person would use to name the row.
   */
  readonly rowHeader?: boolean;

  /** Numbers read right-aligned; everything else reads left-aligned. */
  readonly align?: 'start' | 'end';
}

export interface TableProps<Row> {
  /**
   * What this table is, as a sentence. Rendered as a real `<caption>`: it is the table's accessible
   * name, and a heading sitting above the table is not - assistive technology announcing "table,
   * 4 columns, 30 rows" with no name leaves the reader to guess which table they landed in.
   */
  readonly caption: string;

  readonly columns: readonly TableColumn<Row>[];

  readonly rows: readonly Row[];

  /** A stable identity per row. Row order changes under sorting, so an index would not do. */
  readonly rowKey: (row: Row) => string;

  /** Shown in place of rows when the data has arrived and there is none of it. */
  readonly emptyMessage: string;

  /** True while the rows are still being fetched. Suppresses `emptyMessage`. */
  readonly loading?: boolean;

  /** What the table says while `loading`. Overridable because only the caller knows for what. */
  readonly loadingMessage?: string;

  /** The sort currently applied to `rows`. Absent means the caller's own order. */
  readonly sort?: TableSort;

  /** Reports the sort a header click asked for. Its absence makes every column unsortable. */
  readonly onSortChange?: (sort: TableSort) => void;

  /** Layout only - margin, width, grid placement. Never a restyle of the table. */
  readonly className?: string;
}

const cellPadding = 'px-3 py-2';

const headerText = 'font-heading text-xs tracking-wider uppercase';

/**
 * The sort button fills its header cell rather than sitting inside it, so the whole header is the
 * target. It is a plain `<button>` and not a `<Button>` because none of the four button shapes is a
 * table header - `ghost` would put accent text on every sortable column and make the header row
 * compete with the primary action - but the interaction constants are the shared ones, so hover,
 * press and focus read the same here as everywhere else.
 */
const sortButton = cn(
  'flex w-full cursor-pointer items-center gap-1 rounded-sm text-left transition-colors',
  headerText,
  cellPadding,
  focusRing,
  inkWashStates,
);

const SORT_GLYPH = { ascending: ArrowUp, descending: ArrowDown } as const;

/**
 * The next sort a click on `columnKey` is asking for: reverse the column that is already sorted,
 * start any other column ascending.
 */
function nextSort(columnKey: string, current: TableSort | undefined): TableSort {
  if (current?.columnKey === columnKey) {
    return {
      columnKey,
      direction: current.direction === 'ascending' ? 'descending' : 'ascending',
    };
  }

  return { columnKey, direction: 'ascending' };
}

export function Table<Row>(props: TableProps<Row>): ReactNode {
  const {
    caption,
    columns,
    rows,
    rowKey,
    emptyMessage,
    loading = false,
    loadingMessage = 'Loading',
    sort,
    onSortChange,
    className,
  } = props;

  const message = loading ? loadingMessage : rows.length === 0 ? emptyMessage : null;

  return (
    // `border-separate` with no spacing rather than `border-collapse`: collapsed borders merge the
    // header's hairline into the first row's, which on a 1px divider means one of the two rules
    // silently disappears.
    <table
      aria-busy={loading || undefined}
      className={cn('w-full border-separate border-spacing-0 text-left', className)}
    >
      <Text as="caption" variant="h6" tone="muted" className="pb-2 text-left">
        {caption}
      </Text>

      <thead>
        <tr>
          {columns.map((column) => {
            const sortable = column.sortable === true && onSortChange !== undefined;
            const sorted = sort?.columnKey === column.key ? sort.direction : undefined;
            const alignEnd = column.align === 'end';

            return (
              <th
                key={column.key}
                scope="col"
                // Omitted rather than "none" on a column that cannot be sorted at all: `aria-sort`
                // means "this column participates in sorting", and claiming it everywhere would
                // have a screen reader offer a sort that does not exist.
                aria-sort={sortable ? (sorted ?? 'none') : undefined}
                className={cn(
                  'border-b border-divider text-foreground/70',
                  headerText,
                  sortable ? 'p-0' : cellPadding,
                  alignEnd ? 'text-right' : 'text-left',
                )}
              >
                {sortable ? (
                  <button
                    type="button"
                    onClick={() => {
                      onSortChange(nextSort(column.key, sort));
                    }}
                    className={cn(sortButton, alignEnd ? 'justify-end' : 'justify-start')}
                  >
                    {column.header}
                    {/* Decorative: `aria-sort` on the header already carries the state, and a named
                        glyph would make the button announce its direction twice. The unsorted
                        chevron pair is what tells a sighted reader the column can be sorted. */}
                    <Icon
                      icon={sorted === undefined ? ChevronsUpDown : SORT_GLYPH[sorted]}
                      size="sm"
                    />
                  </button>
                ) : (
                  column.header
                )}
              </th>
            );
          })}
        </tr>
      </thead>

      <tbody>
        {message === null ? (
          rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => {
                const cellClass = cn(
                  'border-b border-divider font-body text-md text-foreground',
                  cellPadding,
                  column.align === 'end' ? 'text-right' : 'text-left',
                );

                return column.rowHeader === true ? (
                  <th key={column.key} scope="row" className={cn(cellClass, 'font-medium')}>
                    {column.cell(row)}
                  </th>
                ) : (
                  <td key={column.key} className={cellClass}>
                    {column.cell(row)}
                  </td>
                );
              })}
            </tr>
          ))
        ) : (
          <tr>
            {/* One cell across the table rather than an empty body: a table with a header and no
                rows renders as a bare rule, which reads as a rendering fault rather than an
                answer. */}
            <td
              colSpan={columns.length}
              className={cn('border-b border-divider text-center', cellPadding)}
            >
              <Text variant="bodySmall" tone="muted">
                {message}
              </Text>
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
