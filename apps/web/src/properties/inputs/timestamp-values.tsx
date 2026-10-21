import { Button, Input, Select, Text } from '@nix/ui';
import { useId, useState, type ReactNode } from 'react';

import { readTimestampValue, readerZone, writeTimestampValue } from '../../views/core/timestamps';
import { readPropertyText } from '../../views/core/container-model';

import { type PropertyInputProps } from './types';
import { cellSelectClasses, controlName } from './shell';
import { useDraft } from './drafts';
import { ReadOnlyValue } from './computed-value';

/**
 * A moment: a local time, and the zone it means.
 *
 * **The zone is shown and editable, not assumed.** A time with no zone is a time that changes
 * meaning when somebody else reads it, and the reader's own zone is only the right default - never
 * the right answer for a thing scheduled somewhere else.
 *
 * The offset is never typed. It is derived from the wall time and the zone when the value is
 * written, so it cannot disagree with them - which is exactly what the server refuses.
 */
export function TimestampValue(props: PropertyInputProps): ReactNode {
  const { item, property, onCommit, disabled = false, error = null, density = 'panel' } = props;
  const controlLabel = controlName(density, item, property);

  const stored = readTimestampValue(item.properties, property.key);
  const raw = readPropertyText(item, property.key);
  const zone = stored?.zone ?? readerZone();

  // The wall clock as the local `datetime-local` field wants it, in the value's own zone rather
  // than the reader's - editing a meeting set in another city should show the time it was set for.
  const local = stored === null ? '' : stored.at.setZone(zone).toFormat("yyyy-MM-dd'T'HH:mm");

  const [draft, setDraft] = useState(local);
  const [draftZone, setDraftZone] = useState(zone);
  const storedKey = `${local}|${zone}`;
  const [seen, setSeen] = useState(storedKey);
  const [sent, setSent] = useState(storedKey);

  if (storedKey !== seen) {
    setSeen(storedKey);
    if (`${draft}|${draftZone}` === sent) {
      setDraft(local);
      setDraftZone(zone);
    }
    setSent(storedKey);
  }

  // Something is stored and it is not a timestamp. Showing an empty field over it would claim the
  // property is unset and offer to overwrite it without ever saying what was there.
  if (stored === null && raw.length > 0) {
    return (
      <ReadOnlyValue
        {...props}
        note={`Stored as "${raw}", which is not a time this field can show. It is left as it is rather than being overwritten.`}
      />
    );
  }

  function commit(nextLocal: string, nextZone: string): void {
    const key = `${nextLocal}|${nextZone}`;
    if (nextLocal.length === 0) {
      setSent(key);
      onCommit(null);
      return;
    }

    const written = writeTimestampValue(nextLocal, nextZone);
    if (written !== null) {
      setSent(key);
      onCommit(written);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <Input
        type="datetime-local"
        aria-label={controlLabel}
        tone={density === 'cell' ? 'plain' : 'default'}
        value={draft}
        disabled={disabled}
        aria-invalid={error === null ? undefined : true}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onBlur={() => {
          commit(draft, draftZone);
        }}
      />

      {density === 'cell' ? (
        <select
          aria-label={`Time zone for ${controlLabel}`}
          value={draftZone}
          disabled={disabled}
          onChange={(event) => {
            setDraftZone(event.target.value);
            commit(draft, event.target.value);
          }}
          className={cellSelectClasses}
        >
          {zoneOptions(draftZone).map((zoneName) => (
            <option key={zoneName} value={zoneName}>
              {zoneName}
            </option>
          ))}
        </select>
      ) : (
        <Select
          aria-label={`Time zone for ${controlLabel}`}
          value={draftZone}
          disabled={disabled}
          onChange={(event) => {
            setDraftZone(event.target.value);
            commit(draft, event.target.value);
          }}
        >
          {zoneOptions(draftZone).map((zoneName) => (
            <option key={zoneName} value={zoneName}>
              {zoneName}
            </option>
          ))}
        </Select>
      )}

      {/* Said out loud rather than only drawn as an invalid frame. A pair of controls with no
          <Field> around them had no place to put the refusal, and a refusal with nowhere to go is
          a refusal nobody reads. */}
      {error === null || error.length === 0 ? null : (
        <Text variant="note" role="alert">
          {error}
        </Text>
      )}
    </div>
  );
}

/**
 * When to be reminded: a date and time in the reader's own zone, and a way to clear it.
 *
 * **The reader's zone, not a zone picker.** A reminder is an instant somebody is told about, on
 * whatever device they are holding; asking which city's clock it follows is a question about a
 * meeting, not about a nudge. So the field shows the stored instant converted to the reader's clock,
 * and writes what they pick in that same zone - still as RFC 9557 with its zone, which is the shape
 * Core's `PropertyType.Reminder` validation accepts (the same check a timestamp gets).
 *
 * **Clearing is its own control.** An empty `datetime-local` is easy to produce by accident on some
 * browsers; a button that says "Clear reminder" is not.
 */
export function ReminderValue(props: PropertyInputProps): ReactNode {
  const { item, property, onCommit, disabled = false, error = null, density = 'panel' } = props;
  const controlLabel = controlName(density, item, property);
  const hintId = useId();
  const errorId = useId();

  const stored = readTimestampValue(item.properties, property.key);
  const raw = readPropertyText(item, property.key);
  const zone = readerZone();
  const local = stored === null ? '' : stored.at.setZone(zone).toFormat("yyyy-MM-dd'T'HH:mm");

  const { draft, setDraft, send } = useDraft(local, onCommit);
  // When the field was drawn, for saying a reminder's time has passed. Read once rather than on
  // every render, which is what a render has to be: the same output for the same input.
  const [openedAt] = useState(() => Date.now());

  if (stored === null && raw.length > 0) {
    return (
      <ReadOnlyValue
        {...props}
        note={`Stored as "${raw}", which is not a time this field can show. It is left as it is rather than being overwritten.`}
      />
    );
  }

  function commit(nextLocal: string): void {
    if (nextLocal === local) return;
    if (nextLocal.length === 0) {
      send(nextLocal, null);
      return;
    }
    const written = writeTimestampValue(nextLocal, zone);
    if (written !== null) send(nextLocal, written);
  }

  const passed = stored !== null && stored.at.toMillis() <= openedAt;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="datetime-local"
          aria-label={controlLabel}
          aria-describedby={
            [
              density === 'cell' ? null : hintId,
              error === null || error.length === 0 ? null : errorId,
            ]
              .filter((id) => id !== null)
              .join(' ') || undefined
          }
          tone={density === 'cell' ? 'plain' : 'default'}
          value={draft}
          disabled={disabled}
          aria-invalid={error === null ? undefined : true}
          className="min-w-0 flex-1"
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onBlur={() => {
            commit(draft);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit(draft);
          }}
        />
        {stored === null ? null : (
          <Button
            type="button"
            variant="ghost"
            disabled={disabled}
            aria-label={`Clear reminder for ${controlLabel}`}
            onClick={() => {
              setDraft('');
              send('', null);
            }}
          >
            Clear
          </Button>
        )}
      </div>
      {density === 'cell' ? null : (
        <Text variant="note" tone="muted" id={hintId}>
          {passed
            ? `This time has passed, so it will not remind you again. Times are in ${zone}.`
            : `You will be notified at this time, in ${zone}.`}
        </Text>
      )}
      {error === null || error.length === 0 ? null : (
        <Text variant="note" role="alert" id={errorId}>
          {error}
        </Text>
      )}
    </div>
  );
}

/**
 * The zones offered, with the value's own always among them.
 *
 * Read from the platform rather than shipped: the browser already carries the IANA database, and a
 * second copy would be bytes spent on something already installed. A build whose runtime cannot
 * enumerate them still offers the two that matter - the reader's, and whatever is already stored.
 */
function zoneOptions(current: string): readonly string[] {
  const supported =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];

  const all = supported.length > 0 ? supported : [readerZone()];
  return all.includes(current) ? all : [current, ...all];
}
