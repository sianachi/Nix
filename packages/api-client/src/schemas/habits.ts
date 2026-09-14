import { z } from 'zod';
import type { components } from '../generated/api.js';

/** Habit schedules use local calendar days; Sunday is 0 and Saturday is 6. */
export const habitSettingsSchema = z.object({
  frequency: z.enum(['daily', 'weekly']),
  weekdays: z.array(z.int().min(0).max(6)),
  timezone: z.string(),
  startDate: z.iso.date(),
  target: z.number().positive(),
  unit: z.string(),
});

export const habitCheckInSchema = z.object({
  id: z.uuid(),
  occurredOn: z.iso.date(),
  completed: z.boolean(),
  quantity: z.number().nonnegative().nullable(),
});

export const habitWeekSummarySchema = z.object({
  weekStart: z.iso.date(),
  planned: z.int().nonnegative(),
  completed: z.int().nonnegative(),
  quantity: z.number().nonnegative(),
});

export const habitTrackerSchema = habitSettingsSchema.extend({
  habitId: z.uuid(),
  checkIns: z.array(habitCheckInSchema),
  weeks: z.array(habitWeekSummarySchema),
  status: z.enum(['active', 'paused', 'archived']).default('active'),
  occurrences: z
    .array(
      z.object({
        date: z.iso.date(),
        scheduled: z.boolean(),
        state: z.string(),
        target: z.number(),
        unit: z.string(),
        quantity: z.number().nullable(),
        completed: z.boolean(),
      }),
    )
    .nullable()
    .default(null),
  progress: z
    .object({
      currentStreak: z.int().nonnegative(),
      bestStreak: z.int().nonnegative(),
      planned: z.int().nonnegative(),
      completed: z.int().nonnegative(),
      completionRate: z.number().nonnegative(),
      quantity: z.number().nonnegative(),
    })
    .nullable()
    .default(null),
  months: z
    .array(
      z.object({
        month: z.string(),
        planned: z.int().nonnegative(),
        completed: z.int().nonnegative(),
        quantity: z.number().nonnegative(),
      }),
    )
    .nullable()
    .default(null),
});

export const habitStatusResponseSchema = z.object({
  habitId: z.uuid(),
  status: z.enum(['active', 'paused', 'archived']),
});

export type HabitSettings = z.infer<typeof habitSettingsSchema>;
export type HabitCheckIn = z.infer<typeof habitCheckInSchema>;
export type HabitWeekSummary = z.infer<typeof habitWeekSummarySchema>;
export type HabitTracker = z.infer<typeof habitTrackerSchema>;
export type HabitStatusResponse = z.infer<typeof habitStatusResponseSchema>;

// Keep boundary parsing tied to the explicitly generated Core contract.
const _trackerContract = habitTrackerSchema satisfies z.ZodType<
  components['schemas']['HabitTrackerResponse']
>;
const _checkInContract = habitCheckInSchema satisfies z.ZodType<
  components['schemas']['HabitCheckInResponse']
>;
void _trackerContract;
void _checkInContract;
