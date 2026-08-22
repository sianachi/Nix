import type { CalendarEntry } from '@nix/api-client';
import { describe, expect, it } from 'vitest';

import { valueForDay, valueForHour } from '../../calendar/reschedule';

/**
 * What a drag writes, tested as arithmetic - no DOM, no render.
 *
 * The zone is the whole risk here. A moment dragged across a grid keeps its time, and "its time"
 * means the time the reader saw, in the reader's zone - not the offset it happens to be stored
 * with. `Pacific/Honolulu` is ten hours west of UTC, so anything that reads a value in the wrong
 * zone comes out a day adrift rather than subtly off.
 */
process.env.TZ = 'Pacific/Honolulu';

function aDate(value: string): CalendarEntry {
  return {
    itemId: 'a',
    title: 'Filing',
    containerId: 'c',
    containerTitle: 'Deadlines',
    dateProperty: 'due',
    value,
    kind: 'date',
    // A stored entry, not one a rule produced.
    generated: false,
    completed: null,
  };
}

function aMoment(value: string): CalendarEntry {
  return {
    itemId: 'b',
    title: 'Standup',
    containerId: 'c',
    containerTitle: 'Sessions',
    dateProperty: 'starts',
    value,
    kind: 'timestamp',
    // A stored entry, not one a rule produced.
    generated: false,
    completed: null,
  };
}

describe('dropping on a day', () => {
  it('moves an all-day entry to that day, and nothing else', () => {
    expect(valueForDay(aDate('2026-03-12'), '2026-03-19', 'Europe/London')).toBe('2026-03-19');
  });

  /**
   * The reason this is not a one-liner. Somebody dragging a nine-o'clock standup from Tuesday to
   * Wednesday means nine o'clock on Wednesday - writing the bare day would discard the time, which
   * is data they never asked to lose and cannot get back from the interface.
   */
  it('keeps a moment at its time when it moves day', () => {
    const moved = valueForDay(
      aMoment('2026-03-17T09:00:00+00:00[Europe/London]'),
      '2026-03-18',
      'Europe/London',
    );

    expect(moved).toContain('2026-03-18T09:00:00');
    expect(moved).toContain('[Europe/London]');
  });

  it('writes the moment in the reader zone it was dragged in', () => {
    const moved = valueForDay(
      aMoment('2026-03-17T09:00:00+00:00[Europe/London]'),
      '2026-03-18',
      'Pacific/Honolulu',
    );

    // The reader is ten hours west, so nine in London is twenty-three the evening before for them -
    // and dropping on the 18th means the 18th *as they see it*.
    expect(moved).toContain('[Pacific/Honolulu]');
    expect(moved).toContain('2026-03-18T23:00:00');
  });

  it('refuses a value it cannot read rather than writing something else', () => {
    expect(valueForDay(aMoment('not a timestamp'), '2026-03-18', 'Europe/London')).toBeNull();
  });
});

describe('dropping on an hour', () => {
  it('moves a moment to that hour of that day', () => {
    const moved = valueForHour(
      aMoment('2026-03-17T09:00:00+00:00[Europe/London]'),
      '2026-03-18',
      14,
      'Europe/London',
    );

    expect(moved).toContain('2026-03-18T14:00:00');
  });

  /**
   * Whether a property holds a day or a moment is its container's schema's decision, not the drop
   * target's. The server parses a `date` column as `yyyy-MM-dd` and nothing else, so writing a
   * timestamp there would make the drag appear to work and then quietly fail.
   */
  it('leaves an all-day entry all-day, and only moves its day', () => {
    expect(valueForHour(aDate('2026-03-12'), '2026-03-19', 14, 'Europe/London')).toBe('2026-03-19');
  });

  it('pads a single-digit hour, so the value is a real timestamp', () => {
    const moved = valueForHour(
      aMoment('2026-03-17T09:00:00+00:00[Europe/London]'),
      '2026-03-18',
      7,
      'Europe/London',
    );

    expect(moved).toContain('2026-03-18T07:00:00');
  });
});
