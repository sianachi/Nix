/**
 * `nixctl recur set|clear|complete` and `nixctl calendar`: recurring items, proven from the
 * terminal.
 *
 * A recurrence rule lives on the item itself: `recur set` replaces it wholesale, `recur clear`
 * removes it so the item stops repeating, and `recur complete` marks one occurrence of its series
 * done. `calendar` is the read that makes a series visible at all - it collates every container's
 * calendar in a workspace, including the days a rule generates rather than stores, so this is the
 * command that proves a rule actually produces the occurrences it promises.
 *
 * Completing the same day twice is success with nothing changed, by contract - the response and
 * this command's exit code are the same whether the day was just completed or already was one.
 *
 * Obviously-wrong input (a frequency outside the closed set, an interval outside 1..366, a
 * malformed date, weekdays named on a non-weekly rule) is refused here, before any request, so a
 * typo fails locally with a sentence naming the flag rather than reaching Core as an opaque 422.
 * Whether a given combination actually makes sense for a rule - an `until` before its first
 * occurrence, for instance - stays Core's judgment, the same way `views set` leaves a view's shape
 * to its 422.
 */

import {
  recurrence,
  workspaceCalendar as calendars,
  type RecurrenceFreq,
  type RecurrenceWeekday,
} from '@nix/api-client';
import { resolveSession, type SessionDeps } from './shared.ts';
import { printResult, type OutputOptions } from '../output.ts';

const FREQS: readonly RecurrenceFreq[] = ['daily', 'weekly', 'monthly', 'yearly'];
const WEEKDAYS: readonly RecurrenceWeekday[] = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'];

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Checks a `yyyy-MM-dd` string names a real calendar day, so an obvious typo (a 13th month, a 31st
 * of April) fails at the prompt instead of reaching Core as an opaque 422.
 */
function isValidDay(value: string): boolean {
  const match = DAY_PATTERN.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function parseDay(value: string, flag: string): string {
  if (!isValidDay(value)) {
    throw new Error(`${flag} must be a real calendar day, yyyy-MM-dd - got '${value}'.`);
  }
  return value;
}

function parseFreq(value: string): RecurrenceFreq {
  if (!(FREQS as readonly string[]).includes(value)) {
    throw new Error(`--freq must be one of ${FREQS.join(', ')} - got '${value}'.`);
  }
  return value as RecurrenceFreq;
}

/** Defaults to 1 (repeat every occurrence) when omitted, matching a rule with no gap between them. */
function parseInterval(value: string | undefined): number {
  if (value === undefined) return 1;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== value.trim() || parsed < 1 || parsed > 366) {
    throw new Error(`--interval must be a whole number between 1 and 366 - got '${value}'.`);
  }
  return parsed;
}

function parseWeekdays(
  value: string | undefined,
  freq: RecurrenceFreq,
): readonly RecurrenceWeekday[] | null {
  if (value === undefined) return null;
  if (freq !== 'weekly') {
    throw new Error(`--weekdays only applies to --freq weekly - got --freq ${freq}.`);
  }
  const tokens = value.split(',').map((token) => token.trim().toLowerCase());
  for (const token of tokens) {
    if (!(WEEKDAYS as readonly string[]).includes(token)) {
      throw new Error(`--weekdays must be from ${WEEKDAYS.join(', ')} - got '${token}'.`);
    }
  }
  return tokens as RecurrenceWeekday[];
}

export interface SetRecurrenceOptions {
  readonly freq: string;
  readonly interval?: string | undefined;
  readonly weekdays?: string | undefined;
  readonly until?: string | undefined;
}

/** Replaces an item's recurrence rule wholesale, printing the rule as Core now stores it. */
export async function setRecurrence(
  profileName: string | undefined,
  itemId: string,
  options: SetRecurrenceOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const freq = parseFreq(options.freq);
  const interval = parseInterval(options.interval);
  const weekdays = parseWeekdays(options.weekdays, freq);
  const until = options.until === undefined ? null : parseDay(options.until, '--until');

  const session = await resolveSession(profileName, deps);
  const answer = await session.client.execute(
    recurrence.setRecurrence(itemId, { freq, interval, weekdays, until }),
  );

  printResult({ id: itemId, rule: answer.rule }, output);
}

/** Clears an item's recurrence rule; the item stops repeating. */
export async function clearRecurrence(
  profileName: string | undefined,
  itemId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  const answer = await session.client.execute(recurrence.clearRecurrence(itemId));
  printResult({ id: itemId, rule: answer.rule }, output);
}

export interface CompleteRecurrenceOptions {
  readonly on: string;
}

/**
 * Marks one occurrence of a recurring item's series complete.
 *
 * Idempotent by contract: completing an already-completed day prints the same shape of success as
 * a fresh completion, never a failure, so a script retrying after a dropped response cannot turn a
 * prior success into an error.
 */
export async function completeRecurrence(
  profileName: string | undefined,
  itemId: string,
  options: CompleteRecurrenceOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const occurredOn = parseDay(options.on, '--on');

  const session = await resolveSession(profileName, deps);
  const answer = await session.client.execute(recurrence.completeOccurrence(itemId, occurredOn));

  printResult({ id: itemId, occurredOn: answer.occurredOn, rule: answer.rule }, output);
}

export interface CalendarOptions {
  readonly workspaceId: string;
  readonly from: string;
  readonly to: string;
}

/**
 * Prints one window of a workspace's collated calendar.
 *
 * This is the read that makes a recurring series visible at all: an entry produced by a rule
 * carries `generated: true` and its own `completed` state, alongside the stored entries it shares
 * the window with. Both truncation flags are surfaced - `entriesTruncated` for concrete entries cut
 * from the window, `seriesTruncated` for repeating series this read could not fully consider - and
 * `unplaceable` is printed in full, since a container or series a rule could not draw is exactly
 * the part of the answer a caller must not miss. A calendar that quietly dropped a series it could
 * not draw would defeat the point of this command.
 */
export async function runCalendar(
  profileName: string | undefined,
  options: CalendarOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const from = parseDay(options.from, '--from');
  const to = parseDay(options.to, '--to');

  const session = await resolveSession(profileName, deps);
  const answer = await session.client.query(
    calendars.workspaceCalendar(options.workspaceId, from, to),
  );

  printResult(
    {
      workspaceId: answer.workspaceId,
      from: answer.from,
      to: answer.to,
      entries: answer.entries.map((entry) => ({
        itemId: entry.itemId,
        title: entry.title,
        containerId: entry.containerId,
        containerTitle: entry.containerTitle,
        dateProperty: entry.dateProperty,
        value: entry.value,
        kind: entry.kind,
        generated: entry.generated,
        completed: entry.completed,
      })),
      count: answer.entries.length,
      entryLimit: answer.entryLimit,
      entriesTruncated: answer.entriesTruncated,
      seriesTruncated: answer.seriesTruncated,
      unplaceable: answer.unplaceable.map((row) => ({
        containerId: row.containerId,
        containerTitle: row.containerTitle,
        reason: row.reason,
        itemId: row.itemId,
        itemTitle: row.itemTitle,
      })),
      unplaceableCount: answer.unplaceable.length,
    },
    output,
  );
}
