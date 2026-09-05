import { useItemDialog } from '../items/item-dialog-context';
import { Button, Text } from '@nix/ui';
import { useState, type ReactElement, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';

import { anchorOf, anchorText, grainOf, windowFor } from '../calendar/calendar-window';
import { CollatedCalendar } from '../calendar/collated-calendar';
import {
  filterByNotes,
  noteOptions,
  notesParam,
  parseNotes,
  unplaceableEntryCount,
} from '../calendar/collated-entries';
import { NoteFilter } from '../calendar/note-filter';
import { useWorkspaceCalendar } from '../calendar/use-workspace-calendar';
import {
  EmptyPanel,
  ErrorPanel,
  LoadingPanel,
  PartialNotice,
} from '../components/states/status-panels';
import { paneScroller } from '../layout/regions';
import { useOpenItem } from '../tabs/use-open-item';
import type { CalendarDay } from '../views/core/calendar-dates';

/**
 * The calendar destination: every calendar in the workspace, drawn as one.
 *
 * A date set in one container used to be invisible from every other. This collates them, so a date
 * is a date wherever it was set - which is only true because the server resolves each container's
 * own date property rather than the client guessing one for the workspace.
 *
 * **Three things it admits to, and none of them are decoration.** The entry ceiling, because a
 * truncated list looks short and announces itself while a truncated calendar looks like a calendar.
 * Containers that offer a calendar and name no property, because a reader who cannot tell "nothing
 * is scheduled" from "that one could not be read" will believe the first. And entries whose stored
 * value this build cannot place, counted rather than dropped.
 *
 * Opening an item goes through the same `useOpenItem` the tree and the palette use, so an item
 * opened from here lands in the pane a reader expects. The calendar does not own a second idea of
 * what is open.
 */

/**
 * The destination's frame: its heading, and whatever state it is in.
 *
 * The heading is outside the state fork on purpose. It answers "where am I", which is true while
 * the calendar is loading, true when it failed, and true when the workspace has nothing scheduled -
 * and a destination that only names itself once it has data leaves a reader on an untitled page in
 * exactly the moments they most need to know where they landed.
 */
function CalendarFrame({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <div className={`${paneScroller} flex flex-col gap-4 p-4`}>
      <Text variant="h2" as="h1">
        Calendar
      </Text>
      {children}
    </div>
  );
}

/** Today, read once per mount rather than per render. */
function todayHere(): CalendarDay {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth(), day: now.getDate() };
}

export function CalendarPage(): ReactElement {
  const [params, setParams] = useSearchParams();
  const { openPreview } = useOpenItem();
  const openDialog = useItemDialog();

  // Read once and held, so a page left open overnight does not silently change what "today" means
  // underneath a reader who is looking at last month.
  const [today] = useState(todayHere);

  const grain = grainOf(params.get('grain'));
  const anchor = anchorOf(params.get('on'), today);
  const window = windowFor(grain, anchor);

  const { status, calendar, error, reload, reschedule, create } = useWorkspaceCalendar(
    window.from,
    window.to,
  );

  // Both replace rather than push: moving through a calendar is not a navigation, and a reader who
  // stepped through six weeks should not have to press Back six times to leave.
  const write = (next: { grain?: string; on?: string; notes?: string }): void => {
    const updated = new URLSearchParams(params);
    if (next.grain !== undefined) {
      updated.set('grain', next.grain);
    }
    if (next.on !== undefined) {
      updated.set('on', next.on);
    }
    if (next.notes !== undefined) {
      // Removed rather than set empty, so "every note" is spelled as absence. Two spellings of one
      // state would leave a later reader unable to tell "never filtered" from "filtered to all".
      if (next.notes.length === 0) {
        updated.delete('notes');
      } else {
        updated.set('notes', next.notes);
      }
    }
    setParams(updated, { replace: true });
  };

  if (status === 'loading') {
    return (
      <CalendarFrame>
        <LoadingPanel label="the workspace calendar" />
      </CalendarFrame>
    );
  }

  if (status === 'error' || calendar === null) {
    return (
      <CalendarFrame>
        <ErrorPanel
          title="The calendar could not be loaded"
          detail={error ?? 'Something went wrong reading this workspace.'}
          action={
            <Button
              onClick={() => {
                void reload();
              }}
            >
              Try again
            </Button>
          }
        />
      </CalendarFrame>
    );
  }

  const unplaceableEntries = unplaceableEntryCount(calendar);
  const unplaceableNotices = describeUnplaceable(calendar.unplaceable);
  const notes = parseNotes(params.get('notes'));
  const options = noteOptions(calendar.entries);
  const shown = filterByNotes(calendar.entries, notes);

  // Nothing scheduled anywhere *and* nothing misconfigured. A workspace with only a misconfigured
  // container is not empty - it has a calendar nobody finished setting up, and saying "nothing to
  // show" would hide the one thing worth acting on.
  if (calendar.entries.length === 0 && calendar.unplaceable.length === 0) {
    return (
      <CalendarFrame>
        <EmptyPanel
          title="Nothing scheduled"
          detail="No item in this workspace carries a date in this range. Give a note a calendar view and a date property, and it will appear here."
        />
      </CalendarFrame>
    );
  }

  return (
    <CalendarFrame>
      {calendar.entriesTruncated && (
        <PartialNotice
          pending={`Showing the first ${String(calendar.entryLimit)} items in this range. Some dated items are not drawn.`}
        />
      )}

      {unplaceableNotices.map((notice) => (
        <PartialNotice key={notice.reason} pending={notice.text} />
      ))}

      {unplaceableEntries > 0 && (
        <PartialNotice
          pending={`${String(unplaceableEntries)} ${unplaceableEntries === 1 ? 'item carries a date' : 'items carry dates'} this version cannot read, so ${unplaceableEntries === 1 ? 'it is' : 'they are'} not drawn.`}
        />
      )}

      <NoteFilter
        options={options}
        selected={notes}
        onChange={(next) => {
          write({ notes: notesParam(next) });
        }}
      />

      <CollatedCalendar
        entries={shown}
        grain={grain}
        onGrain={(next) => {
          write({ grain: next });
        }}
        anchor={anchor}
        onAnchor={(next) => {
          write({ on: anchorText(next) });
        }}
        today={today}
        onOpen={openDialog ?? openPreview}
        onReschedule={(entry, value) => {
          void reschedule(entry.itemId, entry.dateProperty, value);
        }}
        onCreate={create}
      />
    </CalendarFrame>
  );
}

/**
 * What the calendar could not draw, said one reason at a time.
 *
 * Four reasons reach this list and they are not the same fact: a container that never named a date
 * property is a setup somebody has to finish, while a repeating item that cannot be placed is a
 * different problem with a different fix. Collapsing them into one sentence - which this page did
 * while only the first reason existed - would tell three quarters of readers something untrue about
 * their own workspace.
 */
function describeUnplaceable(
  rows: readonly {
    readonly containerTitle: string | null;
    readonly itemTitle?: string | null;
    readonly reason: string;
  }[],
): readonly { readonly reason: string; readonly text: string }[] {
  const byReason = new Map<string, string[]>();
  for (const row of rows) {
    const named = row.itemTitle ?? row.containerTitle ?? 'Untitled';
    byReason.set(row.reason, [...(byReason.get(row.reason) ?? []), named]);
  }

  return [...byReason.entries()].map(([reason, names]) => ({
    reason,
    text: `${names.join(', ')} ${sentenceFor(reason, names.length === 1)}`,
  }));
}

/** The sentence for one reason, in the number the list needs. */
function sentenceFor(reason: string, singular: boolean): string {
  switch (reason) {
    case 'calendar_not_by_due_date':
      return singular
        ? 'repeats, but this calendar places by another property, so its occurrences are not drawn.'
        : 'repeat, but this calendar places by another property, so their occurrences are not drawn.';
    case 'no_due_date':
      return singular
        ? 'repeats but has no due date to repeat from, so nothing is drawn for it.'
        : 'repeat but have no due date to repeat from, so nothing is drawn for them.';
    case 'unreadable_rule':
      return singular
        ? 'carries a repeating rule this version cannot read, so it is not drawn.'
        : 'carry repeating rules this version cannot read, so they are not drawn.';
    default:
      return singular
        ? 'offers a calendar but names no date property, so nothing from it is drawn.'
        : 'offer calendars but name no date property, so nothing from them is drawn.';
  }
}
