import { cn, focusRing, Text } from '@nix/ui';
import { useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';

/**
 * A year of days as a grid of weeks: up to 53 columns of seven, Monday at the top, each day shaded
 * by its value on a four-step scale.
 *
 * **One renderer for every year grid.** A chart view of `chartKind: year`, the habit tracker's
 * insights and, later, a dashboard tile all hand it the same thing - a run of consecutive days with
 * a value and a sentence each - so the scale, the keyboard and the readout are the same everywhere.
 * It knows nothing about items or habits.
 *
 * **The shading is decoration; the sentence is the datum.** Every cell is a button whose accessible
 * name is its sentence ("9 Oct 2026: 3 items"), and focusing or hovering one writes the sentence
 * into a live readout under the grid. Nothing is only a colour.
 *
 * **Four steps of the accent, from tokens.** The design tokens have one accent, so the scale is that
 * accent at a quarter, a half and three quarters strength and then the full accent fill, which
 * flips with the theme. Empty days use the divider tone, so "nothing" is visibly not "a little".
 * The steps are quarters of the largest value, said in the legend in numbers.
 */

export interface YearGridCell {
  /** The day, `yyyy-MM-dd`. Cells are consecutive days, earliest first. */
  readonly date: string;
  /** The value that shades the day; null or zero is an empty day. */
  readonly value: number | null;
  /** The whole sentence a reader hears and sees for the day. */
  readonly label: string;
}

export interface YearGridProps {
  readonly cells: readonly YearGridCell[];
  /** What the grid as a whole shows, for its group label. */
  readonly label: string;
  /** What one unit of value is called in the legend, plural: "items", "times", "minutes". */
  readonly unit: string;
  /** Called when a day is chosen with a click or Enter. */
  readonly onSelect?: ((date: string) => void) | undefined;
  readonly selected?: string | null | undefined;
}

const LEVEL_CLASSES = [
  'bg-divider',
  'bg-accent/25',
  'bg-accent/50',
  'bg-accent/75',
  'bg-accent-fill',
] as const;

const WEEKDAY_INITIALS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const;

/** Monday is zero. */
function weekdayOf(date: string): number {
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}

/** Which of the four steps a value falls in, zero for an empty day. */
export function yearGridLevel(value: number | null, largest: number): number {
  if (value === null || value <= 0 || largest <= 0) {
    return 0;
  }
  return Math.min(4, Math.max(1, Math.ceil((value / largest) * 4)));
}

export function YearGrid({ cells, label, unit, onSelect, selected }: YearGridProps): ReactNode {
  const [active, setActive] = useState<number | null>(null);
  const first = cells[0];
  const offset = first === undefined ? 0 : weekdayOf(first.date);
  const columns = Math.ceil((cells.length + offset) / 7);
  const largest = cells.reduce((most, cell) => Math.max(most, cell.value ?? 0), 0);
  const selectedIndex = cells.findIndex((cell) => cell.date === selected);
  const focusIndex = active ?? (selectedIndex >= 0 ? selectedIndex : cells.length - 1);
  const readout = cells[active ?? -1] ?? cells[selectedIndex];

  // The number of columns is the data, not a chosen dimension: a partial first week still needs
  // its column, and a run shorter than a year needs fewer of them.
  const geometry: CSSProperties = {
    gridTemplateColumns: `repeat(${String(columns)}, var(--year-cell))`,
  };

  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step: Record<string, number> = {
      ArrowUp: -1,
      ArrowDown: 1,
      ArrowLeft: -7,
      ArrowRight: 7,
    };
    let target: number | null = null;
    if (event.key in step) {
      target = index + (step[event.key] ?? 0);
    } else if (event.key === 'Home') {
      target = 0;
    } else if (event.key === 'End') {
      target = cells.length - 1;
    }
    if (target === null) {
      return;
    }
    event.preventDefault();
    const clamped = Math.min(cells.length - 1, Math.max(0, target));
    setActive(clamped);
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>('button')
      .item(clamped)
      .focus();
  };

  if (cells.length === 0) {
    return (
      <Text variant="bodySmall" tone="muted">
        There are no days to show.
      </Text>
    );
  }

  return (
    <div className="flex flex-col gap-2 [--year-cell:calc(var(--spacing)*3)] pointer-coarse:[--year-cell:calc(var(--spacing)*5)]">
      <div className="overflow-x-auto pb-2">
        <div className="flex min-w-fit gap-2">
          <div className="flex shrink-0 flex-col justify-around pt-5" aria-hidden="true">
            {WEEKDAY_INITIALS.map((day, index) => (
              <Text key={index} variant="caption" tone="muted" className="leading-none">
                {index % 2 === 0 ? day : ''}
              </Text>
            ))}
          </div>
          <div>
            <div className="mb-1 grid gap-1" style={geometry} aria-hidden="true">
              {Array.from({ length: columns }, (_, column) => {
                const day = cells[Math.max(0, column * 7 - offset)];
                const before =
                  column === 0 ? undefined : cells[Math.max(0, (column - 1) * 7 - offset)];
                const starts =
                  day !== undefined &&
                  (column === 0 || day.date.slice(0, 7) !== before?.date.slice(0, 7));
                return (
                  <Text
                    key={column}
                    variant="caption"
                    tone="muted"
                    className="overflow-visible whitespace-nowrap leading-none"
                  >
                    {starts
                      ? new Date(`${day.date}T00:00:00Z`).toLocaleDateString(undefined, {
                          month: 'short',
                          timeZone: 'UTC',
                        })
                      : ''}
                  </Text>
                );
              })}
            </div>
            <div
              role="group"
              aria-label={label}
              className="grid grid-flow-col grid-rows-7 gap-1"
              style={geometry}
            >
              {Array.from({ length: offset }, (_, index) => (
                <span key={`pad-${String(index)}`} aria-hidden="true" />
              ))}
              {cells.map((cell, index) => (
                <button
                  key={cell.date}
                  type="button"
                  tabIndex={index === focusIndex ? 0 : -1}
                  aria-label={cell.label}
                  aria-pressed={onSelect === undefined ? undefined : cell.date === selected}
                  className={cn(
                    'size-(--year-cell) rounded-sm',
                    LEVEL_CLASSES[yearGridLevel(cell.value, largest)],
                    cell.date === selected &&
                      'ring-2 ring-accent ring-offset-1 ring-offset-surface',
                    focusRing,
                  )}
                  onMouseEnter={() => {
                    setActive(index);
                  }}
                  onFocus={() => {
                    setActive(index);
                  }}
                  onClick={() => {
                    onSelect?.(cell.date);
                  }}
                  onKeyDown={(event) => {
                    move(event, index);
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      <Text
        variant="bodySmall"
        tone={readout === undefined ? 'muted' : 'default'}
        aria-live="polite"
      >
        {readout === undefined
          ? 'Hover or focus a day to read its value. Arrow keys move by day and by week.'
          : readout.label}
      </Text>

      <div className="flex flex-wrap items-center gap-2" aria-label="Year grid scale">
        <Text as="span" variant="caption" tone="muted">
          None
        </Text>
        {LEVEL_CLASSES.map((level) => (
          <span key={level} className={cn('size-3 rounded-sm', level)} aria-hidden="true" />
        ))}
        <Text as="span" variant="caption" tone="muted">
          {largest > 0
            ? `Four steps up to ${formatScale(largest)} ${unit}, each a quarter of that.`
            : `No ${unit} recorded in this range.`}
        </Text>
      </div>
    </div>
  );
}

function formatScale(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
