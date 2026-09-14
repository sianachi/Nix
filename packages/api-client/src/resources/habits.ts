import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import { noContentSchema } from '../schemas/index.js';
import {
  habitCheckInSchema,
  habitTrackerSchema,
  type HabitCheckIn,
  type HabitTracker,
  habitStatusResponseSchema,
  type HabitStatusResponse,
} from '../schemas/habits.js';

export interface SetHabitInput {
  readonly frequency: 'daily' | 'weekly';
  readonly weekdays: readonly number[] | null;
  readonly timezone: string;
  readonly startDate: string;
  readonly target: number;
  readonly unit: string;
}

export interface HabitCheckInInput {
  readonly completed: boolean;
  readonly quantity: number | null;
}

const habitPath = (itemId: string) => `/api/v1/items/${encodeURIComponent(itemId)}/habit`;
const checkInPath = (itemId: string, day: string) =>
  `${habitPath(itemId)}/check-ins/${encodeURIComponent(day)}`;
const itemKey = (itemId: string) => ['items', itemId] as const;

/** Reads a bounded inclusive range; Core owns the calendar and progress calculations. */
export const readHabit = (itemId: string, from: string, to: string): QueryEndpoint<HabitTracker> =>
  defineQuery({
    operation: 'habits.read',
    path: habitPath(itemId),
    query: { from, to },
    cacheKey: [...itemKey(itemId), 'habit', from, to],
    schema: habitTrackerSchema,
  });

export const setHabit = (itemId: string, input: SetHabitInput): CommandEndpoint<HabitTracker> =>
  defineCommand({
    operation: 'habits.set',
    method: 'PUT',
    path: habitPath(itemId),
    body: input,
    schema: habitTrackerSchema,
    invalidates: [itemKey(itemId)],
  });

/** Sets a day's absolute value. Retrying the same request cannot add a second check-in. */
export const checkIn = (
  itemId: string,
  occurredOn: string,
  input: HabitCheckInInput,
): CommandEndpoint<HabitCheckIn> =>
  defineCommand({
    operation: 'habits.checkIn',
    method: 'PUT',
    path: checkInPath(itemId, occurredOn),
    body: input,
    schema: habitCheckInSchema,
    invalidates: [itemKey(itemId)],
  });

export const undoCheckIn = (itemId: string, occurredOn: string): CommandEndpoint<undefined> =>
  defineCommand({
    operation: 'habits.undoCheckIn',
    method: 'DELETE',
    path: checkInPath(itemId, occurredOn),
    schema: noContentSchema,
    invalidates: [itemKey(itemId)],
  });

export interface SetHabitStatusInput {
  readonly status: 'active' | 'paused' | 'archived';
}

export const setStatus = (
  itemId: string,
  input: SetHabitStatusInput,
): CommandEndpoint<HabitStatusResponse> =>
  defineCommand({
    operation: 'habits.status',
    method: 'PUT',
    path: `${habitPath(itemId)}/status`,
    body: input,
    schema: habitStatusResponseSchema,
    invalidates: [itemKey(itemId)],
  });
