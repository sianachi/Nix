import { Text } from '@nix/ui';
import type { ReactNode } from 'react';

import { dayText, weekOf, type CalendarDay } from '../../core/calendar-dates';
import type { Item } from '../../core/container-model';
import { CreateItemControl } from '../../core/create-item-control';
import type { CardContext } from '../item/card-context';
import { ItemCard } from '../item/item-card';
import { agendaDayLabel } from '../model/day-math';

interface PhoneAgendaProps {
  readonly byDate: ReadonlyMap<string, readonly Item[]>;
  readonly mode: 'month' | 'week' | 'day';
  readonly prefix: string;
  readonly anchor: CalendarDay;
  readonly card: CardContext;
}

/** What a phone opens on: the scheduled days of the window, one list per day. */
export function PhoneAgenda(props: PhoneAgendaProps): ReactNode {
  const { byDate, mode, prefix, anchor, card } = props;

  return (
    <section aria-label="Calendar agenda" className="flex flex-col gap-4">
      {[...byDate]
        .filter(([date]) =>
          mode === 'month'
            ? date.startsWith(prefix)
            : (mode === 'week' ? weekOf(anchor) : [anchor]).some((day) => dayText(day) === date),
        )
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, dated]) => (
          <section key={date} aria-label={agendaDayLabel(date)}>
            <Text as="h3" variant="h6">
              {agendaDayLabel(date)}
            </Text>
            <ul className="flex flex-col gap-2">
              {dated.map((item) => (
                <li key={item.id}>
                  <ItemCard item={item} card={card} occurrenceDate={date} />
                </li>
              ))}
            </ul>

            {/* Always visible - this is the agenda's own per-day add, and the agenda is the
                    view a phone opens on. The month grid's equivalent control can afford to wait
                    for a hover or a focus because a pointer that can hover a cell can also reach
                    the toolbar's control above; a phone has neither, so this one does not hide. */}
            <CreateItemControl
              label={`Add an item on ${agendaDayLabel(date)}`}
              properties={{ [card.dateProperty]: date }}
              onCreate={card.onCreate}
              className="mt-1 self-start"
            />
          </section>
        ))}
      <Text as="p" variant="caption" tone="muted">
        Only scheduled items in this date window appear here.
      </Text>
    </section>
  );
}
