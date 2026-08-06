import { Blueprint, Icon, Text, blueprintFrame, cn, focusRing } from '@nix/ui';
import { CircleAlert } from 'lucide-react';
import { useState, type DragEvent, type ReactNode } from 'react';

import { PartialNotice } from '../components/states/status-panels';
import {
  UNSET_LABEL,
  UNSET_VALUE,
  readPropertyText,
  readSelectValue,
  type Item,
  type PropertyDefinition,
  type View,
} from './container-model';
import { CreateItemControl } from './create-item-control';
import type { ContainerData } from './use-container';
import { drawable, resolveViewChrome, undrawable } from './view-chrome';
import { useViewState } from './view-state';

/**
 * The board: a container's children as cards, in columns, grouped by one select property.
 *
 * **Where a card sits *is* its property value.** The board holds no position of its own - no
 * per-view ordering, no "which column is this card in" stored anywhere. Dropping a card into
 * "Done" writes `status = "Done"` and nothing else, so the same fact is true in the list view, in
 * search, and in whatever reads the property next. A board that kept its own copy of the placement
 * would have two answers to one question, and the day they disagreed the person would be right to
 * trust neither.
 *
 * **Columns are freely definable and are not the property's allowed values.** The view's
 * `groupOrder` names the columns and their order when it says anything at all; the property's
 * declared `options` are only the fallback for a view that has not chosen. This is deliberate and
 * load-bearing: a status property with six options can be shown as a three-column board in an
 * order somebody picked, and adding a seventh option must not silently rearrange every board in
 * the workspace. The cost is that a card whose value is not one of the chosen columns has nowhere
 * to sit, which this view reports rather than hides - see `hidden` below.
 */

export interface BoardViewProps {
  readonly container: ContainerData;
  readonly view: View;

  /** Opening an item is the page's business, not the board's - so the board is told how. */
  readonly onOpen: (itemId: string) => void;
}

interface BoardColumn {
  /** The property value this column writes, or null for the unset column. */
  readonly value: string | null;
  readonly label: string;
  readonly items: readonly Item[];
}

export function BoardView(props: BoardViewProps): ReactNode {
  const { container, view, onOpen } = props;
  const viewState = useViewState();

  // The one piece of genuinely view-local state on this screen: which card the pointer is
  // currently holding. It describes a gesture in progress, not the document, so it is right here
  // and not in the URL or in a store.
  const [dragged, setDragged] = useState<string | null>(null);

  // Whether the board can be drawn at all is resolved before the chrome so the chrome can report
  // it, and handed back by the chrome so this does not have to check it twice. An empty board and a
  // broken board look identical if you let them, and somebody staring at an empty board goes
  // looking for their missing items rather than for the missing property.
  const grouping = resolveGrouping(container, view);

  // The URL's sort wins over the view's own, because it is the more specific statement - somebody
  // chose it just now, possibly in a link they were handed.
  const chrome = resolveViewChrome({
    container,
    viewState,
    subject: 'this board',
    drawable:
      grouping.kind === 'ready'
        ? drawable(grouping.property)
        : undrawable<PropertyDefinition>(describeUnrenderable(grouping, view)),
    emptyTitle: 'Nothing in here yet',
    emptyDetail:
      'Nothing has been added here yet. Items added to this one appear on the board as cards.',
    // Without a column to add to there is no value to set, so this makes an item with none - it
    // lands in the unset column, which is where an item with no status belongs.
    emptyAction: <CreateItemControl label="Add the first item" onCreate={container.create} />,
    filtered: (total) => ({
      title: 'No items match the filters',
      detail: `This holds ${String(total)} items. The filters in the address are hiding all of them, so the board is empty by request rather than because there is nothing here.`,
    }),
    sortBy: viewState.sortBy ?? view.sortBy,
    descending:
      viewState.sortBy === null ? view.sortDescending : viewState.direction === 'descending',
  });

  if (chrome.kind === 'chrome') {
    return chrome.node;
  }

  const property = chrome.drawable;
  const key = property.key;

  const buckets = new Map<string | null, Item[]>();
  for (const item of chrome.items) {
    const value = readSelectValue(item, key);
    const bucket = buckets.get(value);
    if (bucket === undefined) {
      buckets.set(value, [item]);
    } else {
      bucket.push(item);
    }
  }

  const chosen = [...new Set(view.groupOrder.length > 0 ? view.groupOrder : property.options)];

  const columns: readonly BoardColumn[] = [
    ...chosen.map((value) => ({ value, label: value, items: buckets.get(value) ?? [] })),

    // The unset column is not optional. Without it, every item whose grouping property has no
    // value disappears from the board - the single most alarming thing a board can do, because
    // nothing on screen says the items exist. It is rendered even when empty, so the board always
    // shows that it has somewhere to put them.
    { value: null, label: UNSET_LABEL, items: buckets.get(null) ?? [] },
  ];

  const placed = new Set<string | null>([...chosen, null]);
  const hidden = [...buckets].filter(([value]) => !placed.has(value)).flatMap(([, items]) => items);

  function move(item: Item, value: string | null): void {
    if (readSelectValue(item, key) === value) {
      return;
    }

    // Null clears the property. The board writes the grouping property and only the grouping
    // property: there is nothing view-local to keep in step.
    void container.setProperties(item.id, { [key]: value });
  }

  return (
    <div className="flex min-h-0 flex-col gap-3">
      {container.writeError === null ? null : (
        <div
          role="alert"
          className="flex items-start gap-2 border border-divider p-3 font-body text-base text-accent-text"
        >
          <Icon icon={CircleAlert} size="sm" />
          <span>
            {container.writeError} The card has returned to the column it was in; nothing was
            changed.
          </span>
        </div>
      )}

      {/* Two different partial states, said separately: the chrome's is about what the address is
          hiding, and the board's own is about what its columns cannot hold. */}
      {chrome.notice}

      {hidden.length === 0 ? null : (
        <PartialNotice
          pending={`${String(hidden.length)} ${hidden.length === 1 ? 'item is' : 'items are'} not on this board: their ${property.label} is not one of its columns. They are still here.`}
        />
      )}

      <div className="flex min-h-0 items-start gap-3 overflow-x-auto pb-2">
        {columns.map((column) => (
          <BoardColumnPanel
            onCreate={container.create}
            groupKey={key}
            key={column.value ?? UNSET_VALUE}
            column={column}
            columns={columns}
            property={property}
            cardProperties={view.columns.filter((candidate) => candidate !== key)}
            schema={container.schema?.properties ?? []}
            dragged={dragged}
            setDragged={setDragged}
            onMove={move}
            onOpen={onOpen}
          />
        ))}
      </div>
    </div>
  );
}

interface BoardColumnPanelProps {
  readonly column: BoardColumn;
  readonly columns: readonly BoardColumn[];
  readonly property: PropertyDefinition;
  readonly cardProperties: readonly string[];
  readonly schema: readonly PropertyDefinition[];
  readonly dragged: string | null;
  readonly setDragged: (itemId: string | null) => void;
  readonly onMove: (item: Item, value: string | null) => void;
  readonly onOpen: (itemId: string) => void;
  readonly onCreate: (
    title: string,
    properties?: Record<string, unknown>,
  ) => Promise<string | null>;
  readonly groupKey: string;
}

function BoardColumnPanel(props: BoardColumnPanelProps): ReactNode {
  const {
    column,
    columns,
    property,
    cardProperties,
    schema,
    dragged,
    setDragged,
    onMove,
    onOpen,
    onCreate,
    groupKey,
  } = props;

  const [dropTarget, setDropTarget] = useState(false);

  function onDrop(event: DragEvent<HTMLElement>): void {
    event.preventDefault();
    setDropTarget(false);
    setDragged(null);

    if (dragged === null) {
      return;
    }

    // The dragged id is read from state rather than from `dataTransfer`, which the drag start
    // fills only so Firefox will begin the gesture at all. State is the same fact and is available
    // during dragover, where the payload deliberately is not.
    const item = columns
      .flatMap((candidate) => candidate.items)
      .find((candidate) => candidate.id === dragged);

    if (item !== undefined) {
      onMove(item, column.value);
    }
  }

  return (
    <section
      aria-label={column.label}
      onDragOver={(event) => {
        // Preventing the default is what marks this element as a drop target at all; without it
        // the browser refuses the drop and the gesture silently does nothing.
        event.preventDefault();
        setDropTarget(true);
      }}
      onDragLeave={() => {
        setDropTarget(false);
      }}
      onDrop={onDrop}
      className={cn(
        // p-3, not p-2: every other bordered `flex-col gap-2` panel in the views layer - the
        // calendar's unscheduled tray, the timeline's off-axis lists and reschedule panel, the
        // schema and view editors' draft rows - pads at p-3. A column was the one place this rhythm
        // had drifted, and cards inside it sat visibly closer to the frame than the same shape does
        // everywhere else it appears.
        'flex w-80 shrink-0 flex-col gap-2 border border-divider p-3',
        dropTarget && dragged !== null ? 'outline-2 -outline-offset-2 outline-accent' : '',
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <Text variant="h6" as="h3">
          {column.label}
        </Text>
        <Text variant="caption" tone="muted" as="span">
          {column.items.length}
        </Text>
      </div>

      {column.items.length === 0 ? (
        <Text variant="caption" tone="muted" as="p">
          {column.value === null ? `Nothing without a ${property.label.toLowerCase()}.` : 'Empty.'}
        </Text>
      ) : (
        <ul className="flex min-h-0 flex-col gap-2">
          {column.items.map((item) => (
            <BoardCard
              key={item.id}
              item={item}
              columns={columns}
              property={property}
              cardProperties={cardProperties}
              schema={schema}
              dragging={dragged === item.id}
              setDragged={setDragged}
              onMove={onMove}
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}

      {/* Created already in this column, rather than created loose and then dragged. The value the
          column stands for is the value the item gets, which is the same write a drag makes - see
          `move` above. */}
      <CreateItemControl
        label={
          column.value === null
            ? `Add an item without a ${property.label.toLowerCase()}`
            : `Add an item to ${column.label}`
        }
        properties={{ [groupKey]: column.value }}
        onCreate={onCreate}
        className="mt-1 self-start"
      />
    </section>
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
  readonly onOpen: (itemId: string) => void;
}

function BoardCard(props: BoardCardProps): ReactNode {
  const { item, columns, property, cardProperties, schema, dragging, setDragged, onMove, onOpen } =
    props;

  const current = readSelectValue(item, property.key);

  // The view's `columns` are the properties worth showing on a card face. An absent value renders
  // as nothing rather than as an empty row: a card is a summary, and a column of blank labels
  // tells nobody anything.
  const fields = cardProperties.flatMap((candidate) => {
    const definition = schema.find((entry) => entry.key === candidate);
    const text = readPropertyText(item, candidate);
    return definition === undefined || text.length === 0 ? [] : [{ definition, text }];
  });

  return (
    <Blueprint
      as="li"
      className={cn('flex flex-col gap-1.5 bg-background p-3', dragging ? 'opacity-45' : '')}
    >
      <div
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
          type="button"
          onClick={() => {
            onOpen(item.id);
          }}
          className={cn('w-full text-left', focusRing)}
        >
          <Text variant="h5" as="span">
            {item.title || 'Untitled'}
          </Text>
        </button>
      </div>

      {fields.length === 0 ? null : (
        <dl className="flex flex-col gap-0.5">
          {fields.map((field) => (
            <div key={field.definition.key} className="flex gap-2">
              <Text variant="caption" tone="muted" as="dt">
                {field.definition.label}
              </Text>
              <Text variant="caption" as="dd">
                {field.text}
              </Text>
            </div>
          ))}
        </dl>
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
        <select
          // Named per card, not per property: a board of twelve cards would otherwise offer twelve
          // controls all called "Status", and neither a screen reader user nor a test could say
          // which one they were operating.
          aria-label={`${property.label} for ${item.title || 'Untitled'}`}
          value={current ?? UNSET_VALUE}
          onChange={(event) => {
            const next = event.target.value;
            onMove(item, next === UNSET_VALUE ? null : next);
          }}
          className={cn(
            blueprintFrame,
            // One step below the body copy around it, so a control repeated once per card does
            // not out-weigh the card's own title. The line height is the step's own.
            'w-full bg-background px-2 py-1 font-body text-base text-foreground',
            focusRing,
          )}
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
        </select>
      </label>
    </Blueprint>
  );
}

/**
 * Why a board might not be drawable, as data rather than as four scattered early returns.
 *
 * Keeping the reason means the explanation can name the actual problem - a deleted property, a
 * property that is a date - instead of the generic apology a boolean would leave room for.
 */
type Grouping =
  | { readonly kind: 'ready'; readonly property: PropertyDefinition }
  | { readonly kind: 'ungrouped' }
  | { readonly kind: 'missing'; readonly key: string }
  | { readonly kind: 'wrongType'; readonly property: PropertyDefinition }
  | { readonly kind: 'flagged'; readonly property: PropertyDefinition };

function resolveGrouping(container: ContainerData, view: View): Grouping {
  if (view.groupBy === null || view.groupBy.length === 0) {
    return { kind: 'ungrouped' };
  }

  const property = container.schema?.properties.find((candidate) => candidate.key === view.groupBy);

  if (property === undefined) {
    return { kind: 'missing', key: view.groupBy };
  }

  if (property.type !== 'select') {
    return { kind: 'wrongType', property };
  }

  // Core keeps its own list of views it considers unrenderable. When it disagrees with the check
  // above, Core is the one holding the schema this build has not seen, so it wins.
  if ((container.views?.unrenderable ?? []).includes(view.id)) {
    return { kind: 'flagged', property };
  }

  return { kind: 'ready', property };
}

function describeUnrenderable(
  grouping: Exclude<Grouping, { kind: 'ready' }>,
  view: View,
): { readonly title: string; readonly detail: string } {
  switch (grouping.kind) {
    case 'ungrouped':
      return {
        title: 'This board has no grouping property',
        detail: `"${view.name}" is a board, but nothing says which property its columns come from. Give the view a select property to group by and the columns will appear.`,
      };

    case 'missing':
      return {
        title: 'This board groups by a property that no longer exists',
        detail: `"${view.name}" groups by "${grouping.key}", which is not in this item's schema. The items are all still here - it is the property that is gone, so the board cannot say which column each one belongs in.`,
      };

    case 'wrongType':
      return {
        title: 'This board groups by a property that cannot make columns',
        detail: `"${grouping.property.label}" is a ${grouping.property.type} property, and a board's columns come from a select. The items are all still here; only this view cannot draw them.`,
      };

    case 'flagged':
      return {
        title: 'This board cannot be drawn',
        detail: `Core reports that "${view.name}" can no longer be rendered as configured. The items are all still here; the view needs a grouping property it can use.`,
      };
  }
}
