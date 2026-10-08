import { Blueprint, Button, ContextMenu, Icon, Select, Text, cn, focusRing } from '@nix/ui';
import { CircleAlert } from 'lucide-react';
import { useState, type DragEvent, type ReactNode } from 'react';

import { useNarrowViewport } from '../../layout/viewport';
import {
  readPropertyText,
  type Item,
  type PropertyDefinition,
  type View,
} from '../core/container-model';
import { CreateItemControl } from '../core/create-item-control';
import type { ContainerData } from '../core/use-container';
import { useItemContextActions } from '../core/use-item-context-actions';
import {
  describeAxisProblem,
  groupItems,
  resolveViewAxis,
  type AxisGroup,
  type ViewAxis,
} from '../core/view-axis';
import { drawable, undrawable, useViewChrome } from '../core/view-chrome';
import { useViewState } from '../core/view-state';

/**
 * The matrix (plan 3.5): cards in a grid of cells, placed by two properties at once - rows by the
 * view's `rowBy`, columns by its `groupBy`, the board's own field.
 *
 * **A cell is two property values, never a placement.** Exactly as a board's column is its
 * property value, a card's cell here is its row value and its column value and nothing stored
 * against the view. Dragging a card to another cell writes both properties in one update, so the
 * move is a single edit everybody sees, and it can never land half-done with one axis moved.
 *
 * **Drag is never the only way.** Every card carries a "Move to" select naming each cell, which
 * writes the same two values the drag does: a keyboard, a screen reader and a touch screen with
 * assistive technology all reach it, and the two gestures cannot drift apart.
 *
 * **A real table.** Row and column headers are `<th>`s, so a screen reader announces "Urgent,
 * Important" on entering a cell rather than leaving somebody to count. On a phone the table would
 * not fit, so it is drawn as one section per row instead, each listing its cells by column name.
 */

export interface MatrixViewProps {
  readonly container: ContainerData;
  readonly view: View;
  readonly onOpen: (itemId: string) => void;
}

interface MatrixAxes {
  readonly rows: ViewAxis;
  readonly columns: ViewAxis;
}

/** A cell's address: its row group and its column group, "" standing for "no value". */
interface CellAddress {
  readonly row: string;
  readonly column: string;
}

/** Both axes, or the sentence that says why the matrix cannot be drawn. */
function resolveAxes(
  properties: readonly PropertyDefinition[],
  view: View,
): { readonly kind: 'ready'; readonly axes: MatrixAxes } | ({ readonly kind: 'broken' } & Message) {
  const columns = resolveViewAxis(properties, view.groupBy, { allowType: false });
  if (columns.kind !== 'ready') {
    return {
      kind: 'broken',
      title: 'This matrix has no columns to draw',
      detail: `"${view.name}" is a matrix. ${describeAxisProblem(columns, 'columns')} The items are all still here.`,
    };
  }
  const rows = resolveViewAxis(properties, view.rowBy, { allowType: false });
  if (rows.kind !== 'ready') {
    return {
      kind: 'broken',
      title: 'This matrix has no rows to draw',
      detail: `"${view.name}" is a matrix. ${describeAxisProblem(rows, 'rows')} The items are all still here.`,
    };
  }
  if (rows.axis.key === columns.axis.key) {
    return {
      kind: 'broken',
      title: 'This matrix uses one property for both axes',
      detail: `"${view.name}" lays out rows and columns by "${rows.axis.label}". Choose a different property for one of them.`,
    };
  }
  return { kind: 'ready', axes: { rows: rows.axis, columns: columns.axis } };
}

interface Message {
  readonly title: string;
  readonly detail: string;
}

export function MatrixView(props: MatrixViewProps): ReactNode {
  const { container, view, onOpen } = props;
  const viewState = useViewState();
  const narrow = useNarrowViewport();
  const [showEmpty, setShowEmpty] = useState(false);
  const [dragged, setDragged] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const properties = container.schema?.properties ?? [];
  const resolution = resolveAxes(properties, view);

  const chrome = useViewChrome({
    container,
    viewState,
    subject: 'this matrix',
    drawable:
      resolution.kind === 'ready'
        ? drawable(resolution.axes)
        : undrawable<MatrixAxes>({ title: resolution.title, detail: resolution.detail }),
    emptyTitle: 'Nothing in here yet',
    emptyDetail: 'Items added to this one appear in the matrix as cards.',
    emptyAction: <CreateItemControl label="Add the first item" onCreate={container.create} />,
    filtered: (total) => ({
      title: 'No items match the filters',
      detail: `This holds ${String(total)} items. The filters in the address are hiding all of them.`,
    }),
    savedRules: view.filters,
    view,
    sortBy: viewState.sortBy ?? view.sortBy,
    descending:
      viewState.sortBy === null ? view.sortDescending : viewState.direction === 'descending',
  });

  if (chrome.kind === 'chrome') {
    return chrome.node;
  }

  const { rows, columns } = chrome.drawable;
  const rowGroups = groupItems(rows, chrome.items, [], showEmpty);
  const columnGroups = groupItems(columns, chrome.items, view.groupOrder, showEmpty);
  const cellItems = (address: CellAddress): readonly Item[] =>
    chrome.items.filter(
      (item) => rows.groupOf(item) === address.row && columns.groupOf(item) === address.column,
    );
  const cardFields = view.columns.flatMap((key) => {
    if (key === rows.key || key === columns.key) return [];
    const definition = properties.find((candidate) => candidate.key === key);
    return definition === undefined ? [] : [definition];
  });

  function move(item: Item, to: CellAddress): void {
    if (rows.groupOf(item) === to.row && columns.groupOf(item) === to.column) return;
    const writeRow = rows.valueFor;
    const writeColumn = columns.valueFor;
    if (writeRow === undefined || writeColumn === undefined) return;
    setMoveError(null);
    // Both axes in one write: a move is one edit, and it either lands whole or not at all.
    void container
      .setProperties(item.id, {
        [rows.key]: writeRow(to.row),
        [columns.key]: writeColumn(to.column),
      })
      .then(setMoveError);
  }

  // Every cell a card can be moved to, empty or not: the "Move to" choice must reach a cell the
  // grid is currently folding away, or the keyboard could not do what a drag onto it can.
  const cells: readonly CellChoice[] = groupItems(rows, chrome.items, [], true).flatMap((row) =>
    groupItems(columns, chrome.items, view.groupOrder, true).map((column) => ({
      address: { row: row.group, column: column.group },
      label: `${row.label}, ${column.label}`,
    })),
  );

  const cardFor = (item: Item): ReactNode => (
    <MatrixCard
      key={item.id}
      item={item}
      current={{ row: rows.groupOf(item), column: columns.groupOf(item) }}
      cells={cells}
      fields={cardFields}
      dragging={dragged === item.id}
      onDragStart={() => {
        setDragged(item.id);
      }}
      onDragEnd={() => {
        setDragged(null);
      }}
      onMove={(to) => {
        move(item, to);
      }}
      onOpen={onOpen}
    />
  );

  const dropTarget = (address: CellAddress) => ({
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (dragged !== null) event.preventDefault();
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      const item = chrome.items.find((candidate) => candidate.id === dragged);
      setDragged(null);
      if (item !== undefined) move(item, address);
    },
  });

  return (
    <div className="flex min-h-0 flex-col gap-3">
      {moveError === null ? null : (
        <div role="alert" className="flex items-start gap-2 border border-divider p-3">
          <Icon icon={CircleAlert} size="sm" className="text-accent-text" />
          <Text variant="bodySmall" as="span" tone="accent">
            {moveError} The card is back in the cell it was in; nothing was changed.
          </Text>
        </div>
      )}

      {chrome.notice}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          aria-pressed={showEmpty}
          onClick={() => {
            setShowEmpty((current) => !current);
          }}
        >
          Show empty rows and columns
        </Button>
      </div>

      {narrow ? (
        <div className="flex flex-col gap-4">
          {rowGroups.map((row) => (
            <section key={row.group} aria-label={row.label} className="flex flex-col gap-2">
              <Text as="h3" variant="h6">
                {row.label}
              </Text>
              {columnGroups.map((column) => {
                const items = cellItems({ row: row.group, column: column.group });
                return items.length === 0 && !showEmpty ? null : (
                  <div key={column.group} className="flex flex-col gap-2 border border-divider p-3">
                    <Text as="h4" variant="kicker" tone="muted">
                      {column.label}
                    </Text>
                    <CellCards
                      items={items}
                      label={`${row.label}, ${column.label}`}
                      render={cardFor}
                    />
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      ) : (
        <div className="min-w-0 overflow-x-auto">
          <table className="w-full border-collapse">
            <caption className="sr-only">
              {`${view.name}: ${rows.label} in rows, ${columns.label} in columns`}
            </caption>
            <thead>
              <tr>
                <td />
                {columnGroups.map((column) => (
                  <ColumnHeader key={column.group} column={column} />
                ))}
              </tr>
            </thead>
            <tbody>
              {rowGroups.map((row) => (
                <tr key={row.group}>
                  <th scope="row" className="border border-divider p-3 text-left align-top">
                    <Text as="span" variant="h6">
                      {row.label}
                    </Text>
                  </th>
                  {columnGroups.map((column) => {
                    const address = { row: row.group, column: column.group };
                    return (
                      <td
                        key={column.group}
                        {...dropTarget(address)}
                        className="min-w-48 border border-divider p-3 align-top"
                      >
                        <CellCards
                          items={cellItems(address)}
                          label={`${row.label}, ${column.label}`}
                          render={cardFor}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CreateItemControl
        label="Add an item"
        onCreate={container.create}
        className="mt-1 self-start"
      />
    </div>
  );
}

function ColumnHeader({ column }: { readonly column: AxisGroup }): ReactNode {
  return (
    <th scope="col" className="border border-divider p-3 text-left align-bottom">
      <Text as="span" variant="h6">
        {column.label}
      </Text>
    </th>
  );
}

function CellCards({
  items,
  label,
  render,
}: {
  readonly items: readonly Item[];
  readonly label: string;
  readonly render: (item: Item) => ReactNode;
}): ReactNode {
  if (items.length === 0) {
    return (
      <Text as="p" variant="caption" tone="muted">
        Empty.
      </Text>
    );
  }
  return (
    <ul aria-label={`${label} cards`} className="flex flex-col gap-2">
      {items.map(render)}
    </ul>
  );
}

interface CellChoice {
  readonly address: CellAddress;
  readonly label: string;
}

interface MatrixCardProps {
  readonly item: Item;
  readonly current: CellAddress;
  readonly cells: readonly CellChoice[];
  readonly fields: readonly PropertyDefinition[];
  readonly dragging: boolean;
  readonly onDragStart: () => void;
  readonly onDragEnd: () => void;
  readonly onMove: (to: CellAddress) => void;
  readonly onOpen: (itemId: string) => void;
}

/** The value a cell's option carries: both groups, joined by a character no group contains. */
function cellValue(address: CellAddress): string {
  return `${address.row}\u0000${address.column}`;
}

function MatrixCard(props: MatrixCardProps): ReactNode {
  const { item, current, cells, fields, dragging, onDragStart, onDragEnd, onMove, onOpen } = props;
  const itemActions = useItemContextActions(onOpen);
  const title = item.title.length > 0 ? item.title : 'Untitled';

  return (
    <ContextMenu label={`${title} actions`} items={() => itemActions(item.id, item.title)}>
      {(contextTarget) => (
        <li {...contextTarget} className="min-w-0">
          <Blueprint
            className={cn('flex flex-col gap-1.5 bg-background p-3', dragging ? 'opacity-45' : '')}
          >
            <div
              draggable
              onDragStart={(event) => {
                onDragStart();
                event.dataTransfer.effectAllowed = 'move';
                // Without data attached, Firefox refuses to start the drag at all.
                event.dataTransfer.setData('text/plain', item.id);
              }}
              onDragEnd={onDragEnd}
            >
              <button
                type="button"
                onClick={() => {
                  onOpen(item.id);
                }}
                className={cn('w-full text-left', focusRing)}
              >
                <Text variant="h5" as="span" lines={2}>
                  {title}
                </Text>
              </button>
            </div>

            {fields.map((field) => {
              const text = readPropertyText(item, field.key);
              return text.length === 0 ? null : (
                <Text key={field.key} as="span" variant="caption" tone="muted">
                  {`${field.label}: ${text}`}
                </Text>
              );
            })}

            <Select
              aria-label={`Move ${title} to`}
              value={cellValue(current)}
              onChange={(event) => {
                const target = cells.find((cell) => cellValue(cell.address) === event.target.value);
                if (target !== undefined) onMove(target.address);
              }}
            >
              {cells.some((cell) => cellValue(cell.address) === cellValue(current)) ? null : (
                <option value={cellValue(current)}>Where it is now</option>
              )}
              {cells.map((cell) => (
                <option key={cellValue(cell.address)} value={cellValue(cell.address)}>
                  {cell.label}
                </option>
              ))}
            </Select>
          </Blueprint>
        </li>
      )}
    </ContextMenu>
  );
}
