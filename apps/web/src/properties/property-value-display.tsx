import { Avatar, Icon, Tag, Text } from '@nix/ui';
import { Check, Square } from 'lucide-react';
import type { ReactNode } from 'react';

import type { PropertyDefinition, PropertyOwner } from '../views/core/container-model';
import { isComputedType, valueShapeOf } from '../views/core/property-types';
import { readTimestampValue, readerToday, readerZone } from '../views/core/timestamps';
import { useMemberName } from './member-directory';

/**
 * One property value, read rather than edited: a chip for a choice, a glyph for a checkbox, a date
 * in words, a person's initials beside their name.
 *
 * **The read-only twin of `PropertyInput`.** Cards and cells used to show values through the
 * editing control itself, so a board of twenty cards was twenty forms - a select per card, a
 * labelled field per property - and every one of them took a tap that was meant to open the card.
 * This draws the value and nothing else; editing happens where editing belongs, in the item.
 *
 * Returns null for an empty value. A card is a summary, and a row of blank labels tells nobody
 * anything; the caller decides whether a cell needs a placeholder.
 */

export type ValueDensity = 'chip' | 'cell';

export interface PropertyValueDisplayProps {
  readonly item: PropertyOwner;
  readonly property: PropertyDefinition;
  /** `chip` wraps freely, for a card; `cell` stays on one line and truncates, for a grid. */
  readonly density?: ValueDensity;
}

/** The priority scale's words. The number is the value; this is what it means. */
export const PRIORITY_LABELS: Readonly<Record<number, string>> = {
  1: 'Urgent',
  2: 'High',
  3: 'Normal',
  4: 'Low',
};

const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

/**
 * A stored day in words. Formatted in UTC from its own three parts, because a `yyyy-MM-dd` value is
 * a day and not an instant - constructed in the reader's zone it would be the day before for every
 * reader west of Greenwich.
 */
const dayFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

const momentFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function PropertyValueDisplay(props: PropertyValueDisplayProps): ReactNode {
  const { item, property, density = 'chip' } = props;
  const value = item.properties[property.key];

  if (value === null || value === undefined || value === '') {
    return null;
  }

  const wrap = density === 'chip' ? 'flex flex-wrap gap-1' : 'flex min-w-0 gap-1 overflow-hidden';

  if (isComputedType(property.type)) {
    return (
      <Text as="span" variant="caption" tone="muted" truncate={density === 'cell'}>
        {typeof value === 'number' ? numberFormat.format(value) : String(value)}
      </Text>
    );
  }

  switch (property.type) {
    case 'priority':
      return typeof value === 'number' ? (
        <Tag tone={value === 1 ? 'accent' : 'neutral'}>
          {`P${String(value)} ${PRIORITY_LABELS[value] ?? ''}`.trim()}
        </Tag>
      ) : null;
    case 'assignee':
      return typeof value === 'string' ? <AssigneeDisplay id={value} density={density} /> : null;
    case 'url':
      return typeof value === 'string' ? <LinkDisplay href={value} /> : null;
    case 'image':
      // A picture is drawn as a cover where a view chooses one; as a value it would be a thumbnail
      // in every card, which is the gallery's job rather than every view's.
      return null;
    default:
      break;
  }

  switch (valueShapeOf(property.type)) {
    case 'select':
      return typeof value === 'string' ? <Tag>{value}</Tag> : null;
    case 'multi_select':
      return Array.isArray(value) ? (
        <span className={wrap}>
          {value
            .filter((entry): entry is string => typeof entry === 'string')
            .map((entry) => (
              <Tag key={entry}>{entry}</Tag>
            ))}
        </span>
      ) : null;
    case 'checkbox':
      return typeof value === 'boolean' ? (
        <CheckDisplay checked={value} label={property.label} />
      ) : null;
    case 'number':
      return typeof value === 'number' ? (
        <Text as="span" variant="caption" className="tabular-nums">
          {numberFormat.format(value)}
        </Text>
      ) : null;
    case 'date':
    case 'timestamp':
    case 'datetime':
      return <DateDisplay value={value} property={property} item={item} />;
    default:
      return (
        <Text
          as="span"
          variant="caption"
          {...(density === 'cell' ? { truncate: true } : { lines: 2 })}
        >
          {Array.isArray(value) ? value.join(', ') : String(value)}
        </Text>
      );
  }
}

/** Whether a property shows anything at all for this item - for a caller deciding on a row. */
export function hasDisplayValue(item: PropertyOwner, property: PropertyDefinition): boolean {
  const value = item.properties[property.key];
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  return property.type !== 'image';
}

function AssigneeDisplay(props: {
  readonly id: string;
  readonly density: ValueDensity;
}): ReactNode {
  const name = useMemberName(props.id);

  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Avatar name={name ?? '?'} />
      <Text
        as="span"
        variant="caption"
        truncate={props.density === 'cell'}
        tone={name === null ? 'muted' : 'default'}
      >
        {name ?? 'Unknown member'}
      </Text>
    </span>
  );
}

function LinkDisplay(props: { readonly href: string }): ReactNode {
  let shown = props.href;
  try {
    shown = new URL(props.href).hostname || props.href;
  } catch {
    // Not a URL the platform can parse: shown as written, and still a link, because the server
    // accepted it and the browser may know better than a parser what to do with it.
  }

  return (
    <a
      href={props.href}
      target="_blank"
      rel="noopener noreferrer"
      className="min-w-0 truncate text-sm text-accent-text underline underline-offset-2"
      // A link inside a card or a row is its own target; the click must not also open the item.
      onClick={(event) => {
        event.stopPropagation();
      }}
    >
      {shown}
    </a>
  );
}

function CheckDisplay(props: { readonly checked: boolean; readonly label: string }): ReactNode {
  return (
    <span className="inline-flex items-center gap-1">
      <Icon
        icon={props.checked ? Check : Square}
        size="sm"
        className={props.checked ? 'text-foreground' : 'text-muted'}
      />
      <span className="sr-only">{`${props.label}: ${props.checked ? 'yes' : 'no'}`}</span>
    </span>
  );
}

function DateDisplay(props: {
  readonly value: unknown;
  readonly property: PropertyDefinition;
  readonly item: PropertyOwner;
}): ReactNode {
  const { value, property, item } = props;
  if (typeof value !== 'string') return null;

  const stamp = readTimestampValue(item.properties, property.key);
  const day =
    stamp === null ? value.slice(0, 10) : stamp.at.setZone(readerZone()).toFormat('yyyy-MM-dd');
  const shown =
    stamp === null
      ? formatDay(value)
      : momentFormat.format(stamp.at.setZone(readerZone()).toJSDate());

  // Overdue is a fact about a due date, not about every date: a start date in the past is simply a
  // start. Said in words as well as tone, so it is not colour alone.
  const overdue = property.type === 'due_date' && day < readerToday();

  return (
    <Text
      as="span"
      variant="caption"
      tone={overdue ? 'accent' : 'default'}
      className="tabular-nums"
    >
      {shown}
      {overdue ? <span className="sr-only"> (overdue)</span> : null}
    </Text>
  );
}

function formatDay(value: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (parts === null) return value;
  const [, year, month, day] = parts;
  return dayFormat.format(new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))));
}

/** Exposed for a cell that wants the same words without the chrome around them. */
export function formatDisplayNumber(value: number): string {
  return numberFormat.format(value);
}

/** Exposed so a grid's painted cells use the same day words as a card. */
export { formatDay };
