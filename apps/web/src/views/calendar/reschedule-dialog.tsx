import { Button, Dialog, Field, Input } from '@nix/ui';
import { useRef, useState, type ReactNode } from 'react';

import { readDateValue, type Item } from '../core/container-model';
import { readTimestampValue, writeTimestampValue } from '../core/timestamps';

/**
 * The keyboard road to the same write a drag performs, in a modal.
 *
 * Shared by every place an item sits on a calendar and can be moved: the month card, a timed item
 * placed on an hour grid, and the collated calendar's own month cell. All three used to answer only
 * to a pointer - a drag was the sole way to reschedule a card that had already landed somewhere - so
 * this is the one dialog every caller opens instead of reaching for its own copy.
 *
 * A modal rather than a form swapped into the card's place, because the card's place is often a
 * `w-[6.5rem]` month column and a native date input needs roughly 120px to draw its value - the old
 * inline form rendered a control that could not show the date being typed into it.
 *
 * The draft starts as the date the item has now, when it has one. What the form must not do is
 * guess: a draft that is not a `yyyy-MM-dd` date, or not a full `datetime-local` value, is refused
 * here, in the field that can say so, rather than written and refused by Core.
 */

export interface RescheduleDialogProps {
  readonly item: Item;

  /** The property this dialog writes, for reading the value the item has now. */
  readonly dateProperty: string;

  /**
   * Whether the property holds a moment rather than a day.
   *
   * When it does, this dialog takes an hour as well - because an hour slot accepts a drop, and a
   * capability the pointer has and the keyboard does not is the thing ADR-0009 removed.
   */
  readonly placesByTime: boolean;

  /** The reader's zone, which a typed wall-clock time means what it says in. */
  readonly zone: string;
  readonly onCancel: () => void;
  readonly onMove: (value: string | null) => void;

  /**
   * Whether "Remove date" is offered.
   *
   * Defaults to true - the ordinary case, where dropping a card in the unscheduled list is the same
   * write this button reaches. The collated calendar has no unscheduled list to be the counterpart
   * of that write, so it passes false rather than offering a button that would silently do nothing.
   */
  readonly canRemove?: boolean;
}

/**
 * What the reschedule field starts with: the value the item already has, in the shape the control
 * takes.
 *
 * A `datetime-local` input refuses anything that is not a bare wall clock, so a stored moment is
 * converted into the reader's zone and stripped of its offset first - the same reading the grid
 * places it by, so the field agrees with the row the card is sitting on.
 */
function readDraft(item: Item, key: string, placesByTime: boolean, zone: string): string {
  if (!placesByTime) {
    return readDateValue(item, key) ?? '';
  }

  const moment = readTimestampValue(item.properties, key);
  return moment === null ? '' : moment.at.setZone(zone).toFormat("yyyy-MM-dd'T'HH:mm");
}

export function RescheduleDialog(props: RescheduleDialogProps): ReactNode {
  const { item, dateProperty, placesByTime, zone, onCancel, onMove, canRemove = true } = props;
  const [draft, setDraft] = useState(() => readDraft(item, dateProperty, placesByTime, zone));
  const [error, setError] = useState<string | null>(null);
  const fieldRef = useRef<HTMLInputElement>(null);

  function submit(): void {
    if (placesByTime) {
      // What `datetime-local` produces, and what the hour slots write: a wall clock, which the
      // reader's zone turns into a moment. Seconds are optional in the control's own output.
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(draft)) {
        setError('Enter a date and a time of day.');
        return;
      }

      const stored = writeTimestampValue(draft, zone);
      if (stored === null) {
        setError('That is not a time this calendar can place.');
        return;
      }

      onMove(stored);
      return;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft)) {
      setError('Enter a date as year, month and day.');
      return;
    }

    onMove(draft);
  }

  return (
    <Dialog
      open
      title={`Reschedule ${item.title || 'Untitled'}`}
      onClose={onCancel}
      // The dialog's whole purpose is one field, which is the case Dialog documents initialFocus
      // for: landing on the element itself would make the first press a Tab nobody needed.
      initialFocus={fieldRef}
    >
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Justification: the handler adds no interaction of its own - the field and buttons inside stay the controls - it only stops an Escape press, already translated to the dialog's cancel, from bubbling on to outer layers (ADR-0029). */}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        onKeyDown={(event) => {
          // ADR-0029's layering rule: the innermost open layer owns Escape and stops it where it
          // is handled. The platform translates this very keydown into the dialog's `cancel`
          // event, which is what closes it - so propagation is stopped, keeping the press from
          // also reaching a window-level listener like the sidebar drawer's, but the default is
          // NOT prevented, because preventing it here would suppress the cancel event itself.
          if (event.key === 'Escape') {
            event.stopPropagation();
          }
        }}
        className="flex flex-col gap-3"
      >
        <Field
          label={`${placesByTime ? 'New date and time' : 'New date'} for ${item.title || 'Untitled'}`}
          error={error}
        >
          {(control) => (
            <Input
              {...control}
              ref={fieldRef}
              type={placesByTime ? 'datetime-local' : 'date'}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setError(null);
              }}
            />
          )}
        </Field>

        <div className="flex flex-wrap items-center gap-1">
          <Button type="submit" className="py-1 text-sm">
            Move
          </Button>

          {canRemove ? (
            <Button
              variant="secondary"
              className="py-1 text-sm"
              onClick={() => {
                // Parity with dropping a card into the unscheduled list. A gesture the mouse has
                // and the keyboard does not is a gesture half the people here cannot perform.
                onMove(null);
              }}
            >
              Remove date
            </Button>
          ) : null}

          <Button variant="ghost" className="py-1 text-sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
