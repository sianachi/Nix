import { locks, recurrence, structure, workspaceCalendar } from '@nix/api-client';
import type { CompanionPorts } from '../ports.js';
import { checkItem } from '../guards.js';
import { WorkspaceToolRefusal } from '../tool-args.js';

/** How far back and forward from today a repeating task's occurrences are looked for. A
 * repeating task is recognised by the series the workspace calendar draws for it, the same series
 * the calendar view completes occurrences from; Core's item read does not carry the rule itself.
 * A year back means even a yearly series shows at least one occurrence; together the window stays
 * inside the calendar's 400-day limit. */
export const OCCURRENCE_LOOKBACK_DAYS = 366;
export const OCCURRENCE_LOOKAHEAD_DAYS = 31;

const DAY_MS = 24 * 60 * 60 * 1000;

/** What a `complete_task` call will do, decided from fresh reads, before anything is written:
 * set the item's completion field, or complete one occurrence of its repeating series. */
export type TaskCompletionPlan =
  | {
      kind: 'property';
      itemId: string;
      title: string;
      key: string;
      completed: boolean;
      /** The field already holds this value; the write changes nothing. */
      unchanged: boolean;
    }
  | {
      kind: 'occurrence';
      itemId: string;
      title: string;
      occurredOn: string;
    };

export interface TaskCompletionResult {
  id: string;
  title: string;
  completed: boolean;
  recurring: boolean;
  occurredOn?: string;
  unchanged?: true;
}

/** The fence a `complete_task` approval is bound to: approving "mark it done" must not run as
 * "complete the occurrence on another day" because the series moved on in between. */
export function taskCompletionFingerprint(plan: TaskCompletionPlan): string {
  return plan.kind === 'property'
    ? `task:property:${plan.itemId}:${plan.key}:${String(plan.completed)}`
    : `task:occurrence:${plan.itemId}:${plan.occurredOn}`;
}

/** The `completed` flag a `complete_task` call carries in `specJson`. */
export function completedFlag(specJson: string): boolean {
  let raw: unknown;
  try {
    raw = JSON.parse(specJson);
  } catch {
    raw = undefined;
  }
  const completed = (raw as { completed?: unknown } | undefined)?.completed;
  if (typeof completed !== 'boolean')
    throw new WorkspaceToolRefusal('nix_complete_task needs completed as true or false.');
  return completed;
}

function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

const UNPLACEABLE_REASONS: Record<string, string> = {
  no_due_date: 'it has no due date to repeat from',
  calendar_not_by_due_date: 'its calendar is not placed by due date',
  unreadable_rule: 'its repeat rule could not be read',
};

/**
 * Decides how to complete (or reopen) one task. Refuses, before anything is written:
 * - an item whose schema has no completion field, naming `nix_add_fields` as the way to add one;
 * - an item under a lock that is closed to this credential;
 * - a dated item whose repeat status cannot be confirmed (the calendar read was cut short, or the
 *   series cannot be drawn), rather than falling back to the series-wide completion flag;
 * - reopening an occurrence, which has no Core operation;
 * - an occurrence after today: completing ahead cannot be undone, and repeated calls would walk
 *   the series into the future.
 *
 * A repeating task completes its earliest open occurrence on or before today through Core's
 * recurrence completion (`recurrence.completeOccurrence`), so the series moves on exactly as when
 * the owner ticks it in the calendar.
 */
export async function planTaskCompletion(
  ports: CompanionPorts,
  workspaceId: string,
  itemId: string,
  completed: boolean,
  signal: AbortSignal,
): Promise<TaskCompletionPlan> {
  const requestOptions = { signal, forceRefresh: true };
  const item = await checkItem(ports, workspaceId, itemId, signal);
  const schema = await ports.core.query(structure.effectiveSchema(item.id), requestOptions);
  const completion = schema.properties.find((property) => property.type === 'completion');
  if (completion === undefined)
    throw new WorkspaceToolRefusal(
      `“${item.title}” has no completion field, so it cannot be marked done. Add a completion field to its container with nix_add_fields first, then try again.`,
    );
  const lock = await ports.core.query(locks.getItemLock(item.id), requestOptions);
  if (lock.locked && lock.unlockedUntil === null)
    throw new WorkspaceToolRefusal(
      `“${item.title}” is under a lock that is closed. The owner must unlock it in Nix first. Nothing was changed.`,
    );

  const dueField = schema.properties.find((property) => property.type === 'due_date');
  const due = dueField === undefined ? undefined : item.properties[dueField.key];
  // A series needs a due date to anchor to, so an undated item cannot be repeating in a way the
  // calendar (or Core's completion) could act on: there is nothing to look up.
  if (typeof due === 'string' && due.trim()) {
    const today = ports.clock.today();
    const from = shiftDay(today, -OCCURRENCE_LOOKBACK_DAYS);
    const to = shiftDay(today, OCCURRENCE_LOOKAHEAD_DAYS);
    const calendar = await ports.core.query(
      workspaceCalendar.workspaceCalendar(workspaceId, from, to),
      requestOptions,
    );
    const unplaceable = calendar.unplaceable.find((entry) => entry.itemId === item.id);
    const occurrences = calendar.entries
      .filter((entry) => entry.itemId === item.id && entry.generated)
      .map((entry) => ({ day: entry.value.slice(0, 10), completed: entry.completed === true }))
      .sort((left, right) => left.day.localeCompare(right.day));
    if (occurrences.length === 0 && unplaceable !== undefined)
      throw new WorkspaceToolRefusal(
        `“${item.title}” repeats, but its occurrences cannot be read because ${UNPLACEABLE_REASONS[unplaceable.reason] ?? 'its series cannot be drawn'}. Nothing was changed.`,
      );
    if (occurrences.length === 0 && (calendar.entriesTruncated || calendar.seriesTruncated))
      throw new WorkspaceToolRefusal(
        `Nix could not confirm whether “${item.title}” repeats: its calendar holds more than one read returns. Mark it done in Nix. Nothing was changed.`,
      );
    if (occurrences.length > 0) {
      if (!completed)
        throw new WorkspaceToolRefusal(
          `“${item.title}” repeats, and reopening one of its occurrences is not something the pet can do. Nothing was changed.`,
        );
      const open = occurrences.filter((occurrence) => !occurrence.completed);
      const target = open.find((occurrence) => occurrence.day <= today);
      if (target === undefined) {
        const next = open.find((occurrence) => occurrence.day > today);
        throw new WorkspaceToolRefusal(
          next === undefined
            ? `Every occurrence of “${item.title}” from ${from} to ${to} is already done. Nothing was changed.`
            : `“${item.title}” has nothing open up to today; its next occurrence is on ${next.day}. Completing a future occurrence cannot be undone, so the pet does not do it. Nothing was changed.`,
        );
      }
      return { kind: 'occurrence', itemId: item.id, title: item.title, occurredOn: target.day };
    }
  }

  return {
    kind: 'property',
    itemId: item.id,
    title: item.title,
    key: completion.key,
    completed,
    unchanged: (item.properties[completion.key] === true) === completed,
  };
}

/** Runs a plan `planTaskCompletion` produced, through the same Core write the owner's own click
 * would make: the property write a task checkbox makes, or the calendar's occurrence completion. */
export async function completeTask(
  ports: CompanionPorts,
  plan: TaskCompletionPlan,
  signal: AbortSignal,
): Promise<TaskCompletionResult> {
  const requestOptions = { signal, forceRefresh: true };
  if (plan.kind === 'occurrence') {
    const done = await ports.core.execute(
      recurrence.completeOccurrence(plan.itemId, plan.occurredOn),
      requestOptions,
    );
    return {
      id: plan.itemId,
      title: plan.title,
      completed: true,
      recurring: true,
      occurredOn: done.occurredOn,
    };
  }
  // Nothing to write when the field already says so: a repeated "reopen" would otherwise still
  // count as a schedule write in Core and re-attribute the item's due reminders.
  if (!plan.unchanged)
    await ports.core.execute(
      structure.setItemProperties(plan.itemId, { [plan.key]: plan.completed }),
      requestOptions,
    );
  return {
    id: plan.itemId,
    title: plan.title,
    completed: plan.completed,
    recurring: false,
    ...(plan.unchanged ? { unchanged: true as const } : {}),
  };
}
