/** `nixctl habit`: configure a habit and record its daily progress. */

import { habits } from '@nix/api-client';
import { resolveSession, type SessionDeps } from './shared.ts';
import { printResult, type OutputOptions } from '../output.ts';

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDay(value: string, flag: string): string {
  const match = DAY.exec(value);
  if (match === null) throw new Error(`${flag} must be yyyy-MM-dd - got '${value}'.`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() !== Number(match[2]) - 1 ||
    date.getUTCDate() !== Number(match[3])
  ) {
    throw new Error(`${flag} must be a real calendar day - got '${value}'.`);
  }
  return value;
}

function parseWeekdays(value: string | undefined): readonly number[] {
  if (value === undefined || value.trim() === '') return [];
  const tokens = value.split(',').map((token) => token.trim());
  if (tokens.some((token) => !/^\d+$/.test(token))) {
    throw new Error('--weekdays must be comma-separated numbers from 0 (Sunday) to 6 (Saturday).');
  }
  const values = tokens.map((token) => Number(token));
  if (values.some((day) => !WEEKDAYS.includes(day as (typeof WEEKDAYS)[number]))) {
    throw new Error('--weekdays must be comma-separated numbers from 0 (Sunday) to 6 (Saturday).');
  }
  if (new Set(values).size !== values.length)
    throw new Error('--weekdays cannot contain duplicates.');
  return values;
}

function parseTarget(value: string): number {
  const target = Number(value);
  if (!Number.isFinite(target) || target <= 0) {
    throw new Error(`--target must be a positive number - got '${value}'.`);
  }
  return target;
}

export interface SetHabitOptions {
  readonly frequency: string;
  readonly weekdays?: string;
  readonly timezone: string;
  readonly startDate: string;
  readonly target: string;
  readonly unit: string;
}

export async function setHabit(
  profileName: string | undefined,
  habitId: string,
  options: SetHabitOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  if (options.frequency !== 'daily' && options.frequency !== 'weekly') {
    throw new Error(`--frequency must be daily or weekly - got '${options.frequency}'.`);
  }
  if (options.timezone.trim() === '') throw new Error('--timezone cannot be empty.');
  const startDate = parseDay(options.startDate, '--start-date');
  const target = parseTarget(options.target);
  const weekdays = parseWeekdays(options.weekdays);
  if (options.frequency === 'weekly' && weekdays.length === 0) {
    throw new Error('--weekdays is required for a weekly habit.');
  }
  if (options.frequency === 'daily' && weekdays.length > 0) {
    throw new Error('--weekdays only applies to weekly habits.');
  }
  const session = await resolveSession(profileName, deps);
  const answer = await session.client.execute(
    habits.setHabit(habitId, {
      frequency: options.frequency,
      weekdays,
      timezone: options.timezone,
      startDate,
      target,
      unit: options.unit,
    }),
  );
  printResult(answer, output);
}

export interface ReadHabitOptions {
  readonly from: string;
  readonly to: string;
}

export async function readHabit(
  profileName: string | undefined,
  habitId: string,
  options: ReadHabitOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const from = parseDay(options.from, '--from');
  const to = parseDay(options.to, '--to');
  if (from > to) throw new Error('--from must be on or before --to.');
  const session = await resolveSession(profileName, deps);
  printResult(await session.client.query(habits.readHabit(habitId, from, to)), output);
}

export interface CheckInOptions {
  readonly on: string;
  readonly quantity?: string;
  readonly completed: boolean;
}

export async function checkIn(
  profileName: string | undefined,
  habitId: string,
  options: CheckInOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const occurredOn = parseDay(options.on, '--on');
  const quantity = options.quantity === undefined ? null : Number(options.quantity);
  if (quantity !== null && (!Number.isFinite(quantity) || quantity < 0)) {
    throw new Error(
      `--quantity must be a non-negative number - got '${String(options.quantity)}'.`,
    );
  }
  const session = await resolveSession(profileName, deps);
  const answer = await session.client.execute(
    habits.checkIn(habitId, occurredOn, { completed: options.completed, quantity }),
  );
  printResult(answer, output);
}

export async function undoCheckIn(
  profileName: string | undefined,
  habitId: string,
  on: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const occurredOn = parseDay(on, '--on');
  const session = await resolveSession(profileName, deps);
  await session.client.execute(habits.undoCheckIn(habitId, occurredOn));
  printResult({ habitId, occurredOn, undone: true }, output);
}

/** Pause, resume, archive, or restore a habit while retaining its history. */
export async function setHabitStatus(
  profileName: string | undefined,
  habitId: string,
  status: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  if (status !== 'active' && status !== 'paused' && status !== 'archived') {
    throw new Error('Status must be active, paused, or archived.');
  }
  const session = await resolveSession(profileName, deps);
  printResult(await session.client.execute(habits.setStatus(habitId, { status })), output);
}
