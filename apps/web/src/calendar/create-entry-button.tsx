import { Button, Dialog, Field, Icon, Input, Select, Text } from '@nix/ui';
import { Plus } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';

/**
 * Adding a dated entry from the collated calendar.
 *
 * **Answering the question `reschedule.ts` and `collated-calendar.tsx` both used to say had no
 * answer.** Rescheduling works from an entry because the entry already carries the key its own
 * container placed it by; creating has nothing to read that from, because there is no entry yet.
 * Goal 3.10's whole shape is here: ask which container the new item belongs to *first*, then let
 * whatever calls this resolve that container's own date property from its own view configuration -
 * never from whichever entries happen to be on screen.
 *
 * **Closed until asked for**, matching `CreateItemControl` a day cell already draws: one control
 * rather than one per cell, since a collated calendar has no one cell a new item obviously belongs
 * to - the person has to say which note as well as which day.
 */

export interface CalendarDestination {
  readonly id: string;
  readonly title: string;
}

export interface CreateEntryButtonProps {
  /**
   * The containers a new entry may land in.
   *
   * Every one of these already offers a calendar view with a date property - see
   * `use-workspace-calendar.ts`'s `create`, which resolves the property fresh for whichever one is
   * chosen rather than trusting anything carried here.
   */
  readonly destinations: readonly CalendarDestination[];

  /** The day the new entry starts on, `yyyy-MM-dd`. Editable, seeded from where the reader is. */
  readonly day: string;

  /** Makes the item and writes its date. Answers the refusal, or null when it stuck. */
  readonly onCreate: (containerId: string, title: string, day: string) => Promise<string | null>;
}

/**
 * What a reader is told instead of an empty menu.
 *
 * "The picker must not offer a container that cannot place a date" cuts the other way when nothing
 * qualifies: a menu with nothing in it says nothing about why, and a reader cannot fix a control
 * that only shows them absence.
 */
const NO_ELIGIBLE_CONTAINER =
  'No note here offers a calendar with a date property to create into. Give one a calendar view ' +
  'and a date property, and it will appear here as somewhere a new entry can land.';

export function CreateEntryButton(props: CreateEntryButtonProps): ReactNode {
  const { destinations, day, onCreate } = props;

  const [open, setOpen] = useState(false);
  const [containerId, setContainerId] = useState('');
  const [title, setTitle] = useState('');
  const [dayDraft, setDayDraft] = useState(day);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  if (destinations.length === 0) {
    return (
      <Text as="span" variant="note" tone="muted">
        {NO_ELIGIBLE_CONTAINER}
      </Text>
    );
  }

  function openDialog(): void {
    setContainerId(destinations[0]?.id ?? '');
    setTitle('');
    setDayDraft(day);
    setRefusal(null);
    setOpen(true);
  }

  function close(): void {
    setOpen(false);
  }

  async function submit(): Promise<void> {
    const named = title.trim();
    if (named.length === 0 || containerId === '') {
      return;
    }

    setSaving(true);
    setRefusal(null);

    const reason = await onCreate(containerId, named, dayDraft);

    setSaving(false);

    if (reason !== null) {
      // Kept open with what was typed still in it, matching `CreateItemControl`: closing on a
      // refusal would throw away a title somebody just wrote and leave them to retype it.
      setRefusal(reason);
      return;
    }

    close();
  }

  return (
    <>
      <Button
        variant="secondary"
        onClick={() => {
          openDialog();
        }}
      >
        <Icon icon={Plus} size="sm" />
        New entry
      </Button>

      {open && (
        <Dialog open title="New entry" onClose={close} initialFocus={titleRef}>
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Justification: matches RescheduleDialog in calendar-view.tsx - the handler only stops Escape, already translated to the dialog's own cancel, from bubbling to an outer layer (ADR-0029); it adds no interaction of its own. */}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
              }
            }}
            className="flex flex-col gap-3"
          >
            <Field label="Note">
              {(control) => (
                <Select
                  {...control}
                  value={containerId}
                  disabled={saving}
                  onChange={(event) => {
                    setContainerId(event.target.value);
                  }}
                >
                  {destinations.map((destination) => (
                    <option key={destination.id} value={destination.id}>
                      {destination.title}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            <Field label="Date">
              {(control) => (
                <Input
                  {...control}
                  type="date"
                  value={dayDraft}
                  disabled={saving}
                  onChange={(event) => {
                    setDayDraft(event.target.value);
                  }}
                />
              )}
            </Field>

            <Field label="Title" error={refusal}>
              {(control) => (
                <Input
                  {...control}
                  ref={titleRef}
                  value={title}
                  disabled={saving}
                  onChange={(event) => {
                    setTitle(event.target.value);
                    setRefusal(null);
                  }}
                />
              )}
            </Field>

            <div className="flex flex-wrap items-center gap-1">
              <Button type="submit" disabled={saving} className="py-1 text-sm">
                {saving ? 'Creating…' : 'Create'}
              </Button>

              <Button
                variant="ghost"
                className="py-1 text-sm"
                onClick={() => {
                  close();
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        </Dialog>
      )}
    </>
  );
}
