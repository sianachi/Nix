/**
 * The recurrence resource: the only place the recurrence URLs appear.
 *
 * A rule lives on the item itself - `PUT` replaces it wholesale, and a null body clears it so the
 * item stops repeating. Editing an existing rule preserves its completion state, which is Core's
 * job, not this package's. Completing an occurrence is the other write, and is idempotent by
 * contract: completing an already-completed day answers success with nothing changed, never a
 * refusal, so a caller must not present a repeat completion as an error.
 *
 * Both writes invalidate the item's own cache entry, mirroring `structure.setItemProperties` for the
 * same reason it does: a recurrence rule changes what a workspace calendar shows, since a series is
 * drawn from the rule rather than read from storage. Neither write names the workspace the item
 * lives in, so the calendar's own cache key - keyed by workspace and window - is out of reach from
 * here; a caller that just changed a rule and wants a fresh calendar should force a refresh, the same
 * as it would after any other write made mid-window.
 */

import { defineCommand, type CommandEndpoint } from '../endpoints.js';
import {
  completeOccurrenceResultSchema,
  setRecurrenceResultSchema,
  type CompleteOccurrenceResult,
  type RecurrenceFreq,
  type RecurrenceWeekday,
  type SetRecurrenceResult,
} from '../schemas/index.js';

const itemKey = (itemId: string): readonly string[] => ['items', itemId];

export interface SetRecurrenceInput {
  readonly freq: RecurrenceFreq;
  readonly interval: number;
  /** Only meaningful for `freq: 'weekly'`; Core is the judge of that, not this client. */
  readonly weekdays: readonly RecurrenceWeekday[] | null;
  /** The last day the item is due, inclusive, or null for a rule with no end. */
  readonly until: string | null;
}

/** Replaces an item's recurrence rule wholesale, returning the rule as Core now stores it. */
export const setRecurrence = (
  itemId: string,
  input: SetRecurrenceInput,
): CommandEndpoint<SetRecurrenceResult> =>
  defineCommand<SetRecurrenceResult>({
    operation: 'recurrence.set',
    method: 'PUT',
    path: `/api/v1/items/${itemId}/recurrence`,
    schema: setRecurrenceResultSchema,
    body: {
      freq: input.freq,
      interval: input.interval,
      weekdays: input.weekdays,
      until: input.until,
    },
    invalidates: [itemKey(itemId)],
  });

/** Clears an item's recurrence rule; a null body is how the endpoint spells "stop repeating". */
export const clearRecurrence = (itemId: string): CommandEndpoint<SetRecurrenceResult> =>
  defineCommand<SetRecurrenceResult>({
    operation: 'recurrence.clear',
    method: 'PUT',
    path: `/api/v1/items/${itemId}/recurrence`,
    schema: setRecurrenceResultSchema,
    body: null,
    invalidates: [itemKey(itemId)],
  });

/**
 * Marks one day of a recurring item's series complete.
 *
 * Idempotent by contract: completing an already-completed day succeeds with nothing changed, so a
 * caller retrying after a dropped response cannot turn a prior success into a failure by asking
 * again.
 */
export const completeOccurrence = (
  itemId: string,
  occurredOn: string,
): CommandEndpoint<CompleteOccurrenceResult> =>
  defineCommand<CompleteOccurrenceResult>({
    operation: 'recurrence.complete',
    method: 'POST',
    path: `/api/v1/items/${itemId}/recurrence/completions`,
    schema: completeOccurrenceResultSchema,
    body: { occurredOn },
    invalidates: [itemKey(itemId)],
  });
