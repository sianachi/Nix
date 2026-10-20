import {
  Button,
  ContextMenu,
  Select,
  Text,
  cn,
  type ContextMenuTargetProps,
  type TableColumn,
} from '@nix/ui';
import { useState, type ReactNode } from 'react';

import type { Item } from '../core/container-model';
import { SELECT_COLUMN_KEY } from './list-columns';
import type { ListRowsProps } from './list-rows';

export function MobileListRows({
  items,
  columns: allColumns,
  sort,
  onSortChange,
  rowContextMenu,
  rowSelection,
  caption,
  showSort,
}: ListRowsProps & { readonly showSort: boolean }): ReactNode {
  const [limit, setLimit] = useState(40);
  // The selection gutter is not a field: it is drawn beside the row, and only while selecting.
  const columns = allColumns.filter((column) => column.key !== SELECT_COLUMN_KEY);
  const selectColumn = allColumns.find((column) => column.key === SELECT_COLUMN_KEY);
  const selecting = items.some(rowSelection.selected);
  return (
    <section aria-label={caption} className="flex min-w-0 flex-col gap-3">
      {showSort ? (
        <MobileSortBar columns={columns} sort={sort} onSortChange={onSortChange} />
      ) : null}
      <ul className="divide-y divide-divider">
        {items.slice(0, limit).map((item) =>
          // A long press is the phone's right-click: the same actions the desktop rows offer, so a
          // row on a phone is not the one place an item cannot be moved, pinned or deleted from.
          rowContextMenu === undefined ? (
            <MobileRow
              key={item.id}
              item={item}
              columns={columns}
              selectColumn={selecting ? selectColumn : undefined}
              selected={rowSelection.selected(item)}
            />
          ) : (
            <ContextMenu
              key={item.id}
              label={`${item.title || 'Untitled'} actions`}
              items={() => rowContextMenu(item)}
              {...(rowSelection.longPress === undefined
                ? {}
                : { onLongPress: () => rowSelection.longPress?.(item) === true })}
            >
              {(contextTarget) => (
                <MobileRow
                  item={item}
                  columns={columns}
                  target={contextTarget}
                  selectColumn={selecting ? selectColumn : undefined}
                  selected={rowSelection.selected(item)}
                />
              )}
            </ContextMenu>
          ),
        )}
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

/**
 * The phone's sort control: a select for the key and a button for the direction, because a phone
 * has no column headers to click. Drawn once above a grouped list rather than once per section -
 * the sort applies inside every section alike, and five copies of one control would be four
 * controls too many.
 */
export function MobileSortBar({
  columns,
  sort,
  onSortChange,
}: Pick<ListRowsProps, 'columns' | 'sort' | 'onSortChange'>): ReactNode {
  return (
    <div role="group" aria-label="List sort" className="flex flex-wrap items-center gap-2">
      <Text as="span" variant="caption">
        Sort by
      </Text>
      <Select
        aria-label="Sort by"
        value={sort?.columnKey ?? ''}
        className="w-auto min-w-0 flex-1"
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
      </Select>
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
    </div>
  );
}

/** One phone row: the first column's cell, and the rest folded under "Fields". */
function MobileRow(props: {
  readonly item: Item;
  readonly columns: ListRowsProps['columns'];
  readonly target?: ContextMenuTargetProps;
  readonly selectColumn?: TableColumn<Item> | undefined;
  readonly selected: boolean;
}): ReactNode {
  const { item, columns, target, selectColumn, selected } = props;

  return (
    <li {...target} className={cn('min-w-0 py-3', selected && 'bg-accent/10')}>
      <div className="flex items-center gap-2 py-2">
        {selectColumn?.cell(item)}
        {columns[0]?.cell(item)}
      </div>
      {columns.length > 1 ? (
        <details>
          <summary className="cursor-default py-2">Fields</summary>
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
  );
}
