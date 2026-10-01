/**
 * `nixctl remind set|clear`: an item's explicit reminder (ADR-0051 section 4).
 *
 * A reminder is the item's reserved `reminder` property, an RFC 9557 time with its zone such as
 * `2026-10-01T09:00:00+01:00[Europe/London]`, fired once to whoever set it. `props set` can
 * already write that value; this command exists because writing it by hand means knowing the
 * zone's offset on that day. It accepts what a person types - a local time, an instant, or a
 * relative `+90m` - and writes the exact value Core validates.
 *
 * The zone is `--zone`, else the caller's own preference (`nixctl notifications prefs`), so a
 * local time means the same thing here as it does to the reminder planner.
 */

import { notifications, structure } from '@nix/api-client';
import { parseTimeZone, parseUuid, resolveSession, type SessionDeps } from './shared.ts';
import { printResult, type OutputOptions } from '../output.ts';
import type { Session } from '../session.ts';

const RELATIVE = /^\+(\d{1,6})([mhd])$/;
const ABSOLUTE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?(?:\[([^\]]+)\])?$/;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const MAX_RELATIVE_MS = 366 * UNIT_MS.d;
const DAY_MS = UNIT_MS.d;

const SHAPES =
  'Use a local time like 2026-10-01T09:00, an instant like 2026-10-01T08:00:00Z, a zoned time like 2026-10-01T09:00:00+01:00[Europe/London], or a relative time like +90m, +2h or +1d.';

interface Wall {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/**
 * Turns what a person typed into the RFC 9557 value Core stores.
 *
 * @param when The typed time.
 * @param zone The IANA zone a local or relative time is expressed in.
 * @param now The clock a relative time counts from.
 * @throws When the text is none of the accepted shapes, or names an impossible moment.
 */
export function resolveReminderWhen(when: string, zone: string, now: Date): string {
  const text = when.trim();

  const relative = RELATIVE.exec(text);
  if (relative !== null) {
    const amount = Number(relative[1]);
    const unit = relative[2] as keyof typeof UNIT_MS;
    const delta = amount * UNIT_MS[unit];
    if (amount < 1 || delta > MAX_RELATIVE_MS) {
      throw new Error(`A relative reminder must be from +1m up to a year ahead - got '${when}'.`);
    }
    return format(Math.floor(now.getTime() / 1000) * 1000 + delta, zone);
  }

  const absolute = ABSOLUTE.exec(text);
  if (absolute === null) {
    throw new Error(`'${when}' is not a time this command reads. ${SHAPES}`);
  }
  const wall: Wall = {
    year: Number(absolute[1]),
    month: Number(absolute[2]),
    day: Number(absolute[3]),
    hour: Number(absolute[4]),
    minute: Number(absolute[5]),
    second: Number(absolute[6] ?? '0'),
  };
  assertRealWall(wall, when);
  const offsetText = absolute[7];
  const bracketZone = absolute[8];
  const targetZone =
    bracketZone === undefined ? zone : parseTimeZone(bracketZone, `The zone in '${when}'`);

  if (offsetText === undefined) {
    return format(instantOfWall(wall, targetZone), targetZone);
  }

  const offsetMinutes = parseOffset(offsetText);
  const instant = wallAsUtc(wall) - offsetMinutes * 60_000;
  if (bracketZone !== undefined && offsetAt(targetZone, instant) !== offsetMinutes) {
    throw new Error(`'${when}' has an offset that '${targetZone}' was not using at that moment.`);
  }
  return format(instant, targetZone);
}

export interface ReminderOptions {
  /** The IANA zone a local time is read in; the caller's preference when absent. */
  readonly zone?: string | undefined;
}

export interface ReminderResult {
  readonly id: string;
  readonly title: string;
  readonly reminder: string | null;
}

/** Sets the reminder, reading the caller's preferred zone when none is given. */
export async function executeSetReminder(
  session: Session,
  itemId: string,
  when: string,
  options: ReminderOptions,
  now: Date = new Date(),
): Promise<ReminderResult> {
  const zone =
    options.zone === undefined
      ? (await session.client.query(notifications.preferences(), { forceRefresh: true })).timeZone
      : parseTimeZone(options.zone, '--zone');
  const reminder = resolveReminderWhen(when, zone, now);
  const item = await session.client.execute(structure.setItemProperties(itemId, { reminder }));
  return { id: item.id, title: item.title, reminder };
}

/** Removes the reminder; a pending one is cancelled when the planner next reconciles. */
export async function executeClearReminder(
  session: Session,
  itemId: string,
): Promise<ReminderResult> {
  const item = await session.client.execute(
    structure.setItemProperties(itemId, { reminder: null }),
  );
  return { id: item.id, title: item.title, reminder: null };
}

export async function setReminder(
  profileName: string | undefined,
  itemId: string,
  when: string,
  options: ReminderOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  parseUuid(itemId, 'The item');
  const zone = options.zone === undefined ? 'UTC' : parseTimeZone(options.zone, '--zone');
  // Refuse a malformed time before any request; the real zone is resolved below.
  resolveReminderWhen(when, zone, new Date());
  const session = await resolveSession(profileName, deps);
  printResult(await executeSetReminder(session, itemId, when, options), output);
}

export async function clearReminder(
  profileName: string | undefined,
  itemId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  parseUuid(itemId, 'The item');
  const session = await resolveSession(profileName, deps);
  printResult(await executeClearReminder(session, itemId), output);
}

function assertRealWall(wall: Wall, when: string): void {
  const probe = new Date(wallAsUtc(wall));
  if (
    probe.getUTCFullYear() !== wall.year ||
    probe.getUTCMonth() !== wall.month - 1 ||
    probe.getUTCDate() !== wall.day ||
    wall.hour > 23 ||
    wall.minute > 59 ||
    wall.second > 59
  ) {
    throw new Error(`'${when}' is not a real calendar time.`);
  }
}

function wallAsUtc(wall: Wall): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
}

function parseOffset(text: string): number {
  if (text === 'Z') return 0;
  const sign = text.startsWith('-') ? -1 : 1;
  const hours = Number(text.slice(1, 3));
  const minutes = Number(text.slice(4, 6));
  return sign * (hours * 60 + minutes);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function wallAt(zone: string, instant: number): Wall {
  let formatter = formatters.get(zone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, formatter);
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** The zone's UTC offset at an instant, in whole minutes east of UTC. */
function offsetAt(zone: string, instant: number): number {
  const whole = Math.floor(instant / 1000) * 1000;
  return Math.round((wallAsUtc(wallAt(zone, whole)) - whole) / 60_000);
}

/**
 * The instant a wall time names in a zone. The offsets in force a day either side give at most two
 * candidates; a candidate is real when the zone uses that offset at that instant. In a fall-back
 * overlap both are real and the earlier is taken; in a spring-forward gap neither is, and the time
 * moves forward by the gap (read with the offset before the change), on either side of UTC.
 */
function instantOfWall(wall: Wall, zone: string): number {
  const local = wallAsUtc(wall);
  const before = offsetAt(zone, local - DAY_MS);
  const after = offsetAt(zone, local + DAY_MS);
  const real = [...new Set([before, after])]
    .map((offset) => ({ offset, instant: local - offset * 60_000 }))
    .sort((a, b) => a.instant - b.instant)
    .find((candidate) => offsetAt(zone, candidate.instant) === candidate.offset);
  return real === undefined ? local - before * 60_000 : real.instant;
}

function format(instant: number, zone: string): string {
  const wall = wallAt(zone, instant);
  const offset = offsetAt(zone, instant);
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  const sign = offset < 0 ? '-' : '+';
  const magnitude = Math.abs(offset);
  return (
    `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}:` +
    `${pad(wall.second)}${sign}${pad(Math.floor(magnitude / 60))}:${pad(magnitude % 60)}[${zone}]`
  );
}
