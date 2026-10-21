import { ContextMenu, Select, Blueprint, Text, cn, focusRing } from '@nix/ui';
import { useRef, type ReactNode } from 'react';

import type { StaleMember } from '../../lib/suggest/staleness';
import {
  UNSET_VALUE,
  readSelectValue,
  type Item,
  type PropertyDefinition,
  type PropertyValue,
} from '../core/container-model';
import { useItemOpenProps } from '../core/item-open-click';
import { useOptionalItemSelection } from '../core/item-selection-context';
import { SelectCheckbox } from '../core/select-checkbox';
import { useItemContextActions } from '../core/use-item-context-actions';
import { ListCell } from '../list/list-cell';
import { staleDismissalKey, type BoardColumn } from './board-grouping';
import { StaleCardHint } from './stale-card-hint';

export interface BoardCardListProps {
  readonly items: readonly Item[];
  readonly label: string;
  readonly columns: readonly BoardColumn[];
  readonly property: PropertyDefinition;
  readonly cardProperties: readonly string[];
  readonly schema: readonly PropertyDefinition[];
  readonly dragged: string | null;
  readonly setDragged: (itemId: string | null) => void;
  readonly onMove: (item: Item, value: string | null) => void;
  readonly onWrite: (
    itemId: string,
    propertyKey: string,
    value: PropertyValue,
  ) => Promise<string | null>;
  readonly onOpen: (itemId: string) => void;
  readonly stale: ReadonlyMap<string, StaleMember>;
  readonly dismissedStale: ReadonlySet<string>;
  readonly onDismissStale: (item: Item) => void;
}

export function boardCard(
  props: BoardCardListProps,
  item: Item,
  index: number,
  virtualIndex?: number,
): ReactNode {
  return (
    <BoardCard
      key={item.id}
      item={item}
      columns={props.columns}
      property={props.property}
      cardProperties={props.cardProperties}
      schema={props.schema}
      dragging={props.dragged === item.id}
      setDragged={props.setDragged}
      onMove={props.onMove}
      onWrite={props.onWrite}
      onOpen={props.onOpen}
      columnLabel={props.label}
      stale={
        props.dismissedStale.has(staleDismissalKey(item)) ? undefined : props.stale.get(item.id)
      }
      onDismissStale={props.onDismissStale}
      position={index + 1}
      setSize={props.items.length}
      {...(virtualIndex === undefined ? {} : { virtualIndex })}
    />
  );
}

interface BoardCardProps {
  readonly item: Item;
  readonly columns: readonly BoardColumn[];
  readonly property: PropertyDefinition;
  readonly cardProperties: readonly string[];
  readonly schema: readonly PropertyDefinition[];
  readonly dragging: boolean;
  readonly setDragged: (itemId: string | null) => void;
  readonly onMove: (item: Item, value: string | null) => void;
  readonly onWrite: (
    itemId: string,
    propertyKey: string,
    value: PropertyValue,
  ) => Promise<string | null>;
  readonly onOpen: (itemId: string) => void;
  readonly position: number;
  readonly setSize: number;
  readonly virtualIndex?: number;

  /** The column the card sits in, for the stale note's sentence. */
  readonly columnLabel: string;

  /** Set when the card has gone untouched far longer than its column's usual and not been waved off. */
  readonly stale: StaleMember | undefined;
  readonly onDismissStale: (item: Item) => void;
}

function BoardCard(props: BoardCardProps): ReactNode {
  const {
    item,
    columns,
    property,
    cardProperties,
    schema,
    dragging,
    setDragged,
    onMove,
    onWrite,
    onOpen,
    position,
    setSize,
    virtualIndex,
    columnLabel,
    stale,
    onDismissStale,
  } = props;
  const itemActions = useItemContextActions(onOpen);
  const openProps = useItemOpenProps(onOpen);
  const isSelected = useOptionalItemSelection()?.selected.has(item.id) === true;

  const current = readSelectValue(item, property.key);
  const titleRef = useRef<HTMLButtonElement>(null);

  // The view's `columns` are the properties worth showing on a card face, each as its label and an
  // editable value - an empty one included, so a value can be filled in from the card.
  const fields = cardProperties.flatMap((candidate) => {
    const definition = schema.find((entry) => entry.key === candidate);
    return definition === undefined ? [] : [definition];
  });

  return (
    <ContextMenu
      label={`${item.title || 'Untitled'} actions`}
      items={() => itemActions(item.id, item.title)}
    >
      {(contextTarget) => (
        <li
          {...contextTarget}
          {...(virtualIndex === undefined ? {} : { role: 'listitem' })}
          aria-posinset={position}
          aria-setsize={setSize}
          data-virtual-index={virtualIndex}
          className="group min-w-0"
        >
          <Blueprint
            className={cn(
              'flex flex-col gap-1.5 bg-background p-3',
              dragging ? 'opacity-45' : '',
              isSelected && 'bg-accent/10 outline-2 -outline-offset-2 outline-accent',
            )}
          >
            <div className="flex items-start gap-2">
              {/* Beside the draggable title, not inside it, so pressing the box never starts a drag. */}
              <SelectCheckbox item={item} />
              <div
                className="min-w-0 flex-1"
                draggable
                onDragStart={(event) => {
                  setDragged(item.id);
                  event.dataTransfer.effectAllowed = 'move';
                  // Set, though the drop handler prefers its own state: without data attached, Firefox
                  // refuses to start the drag at all.
                  event.dataTransfer.setData('text/plain', item.id);
                }}
                onDragEnd={() => {
                  setDragged(null);
                }}
              >
                <button
                  ref={titleRef}
                  type="button"
                  {...openProps(item.id)}
                  className={cn('w-full text-left', focusRing)}
                >
                  <Text variant="h5" as="span" lines={2}>
                    {item.title || 'Untitled'}
                  </Text>
                </button>
              </div>
            </div>

            {stale === undefined ? null : (
              <StaleCardHint
                title={item.title}
                columnLabel={columnLabel}
                ageMs={stale.ageMs}
                medianMs={stale.medianMs}
                onDismiss={() => {
                  onDismissStale(item);
                  // The dismiss button goes with the note; focus lands on the card it was about
                  // rather than falling to the document (WCAG 2.4.3).
                  titleRef.current?.focus();
                }}
              />
            )}

            {fields.length === 0 ? null : (
              <div className="flex flex-col gap-1">
                {fields.map((field) => (
                  <div key={field.key}>
                    <Text variant="kicker" tone="muted" as="span">
                      {field.label}
                    </Text>
                    <ListCell
                      density="card"
                      item={item}
                      property={field}
                      onWrite={(value) => onWrite(item.id, field.key, value)}
                    />
                  </div>
                ))}
              </div>
            )}

            {/*
        Drag is not the only way to move a card, and it never can be: a keyboard user, a screen
        reader user and anyone on a touch device with assistive technology all need this control.
        It carries the same meaning as the drag - it writes the grouping property - so the two
        gestures cannot drift apart.
      */}
            <label className="flex flex-col gap-0.5">
              <Text variant="kicker" tone="muted" as="span">
                {property.label}
              </Text>
              <Select
                // Named per card, not per property: a board of twelve cards would otherwise offer twelve
                // controls all called "Status", and neither a screen reader user nor a test could say
                // which one they were operating.
                aria-label={`${property.label} for ${item.title || 'Untitled'}`}
                value={current ?? UNSET_VALUE}
                onChange={(event) => {
                  const next = event.target.value;
                  onMove(item, next === UNSET_VALUE ? null : next);
                }}
              >
                {/*
            The card's current value is offered even when it is not one of the board's columns, so
            a card that arrived here with a value this board does not show can still be read
            without the control silently reporting some other column.
          */}
                {current !== null && !columns.some((column) => column.value === current) ? (
                  <option value={current}>{current}</option>
                ) : null}

                {columns.map((column) => (
                  <option key={column.value ?? UNSET_VALUE} value={column.value ?? UNSET_VALUE}>
                    {column.label}
                  </option>
                ))}
              </Select>
            </label>
          </Blueprint>
        </li>
      )}
    </ContextMenu>
  );
}
