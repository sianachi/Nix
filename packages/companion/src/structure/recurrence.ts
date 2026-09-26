import { recurrence } from '@nix/api-client';
import { compileRecurrence, type RecurrenceSpec, type Step } from '@nix/structure-spec';
import type { CompanionPorts } from '../ports.js';

function weekdayName(day: number): 'mo' | 'tu' | 'we' | 'th' | 'fr' | 'sa' | 'su' {
  switch (day) {
    case 1:
      return 'mo';
    case 2:
      return 'tu';
    case 3:
      return 'we';
    case 4:
      return 'th';
    case 5:
      return 'fr';
    case 6:
      return 'sa';
    case 7:
      return 'su';
    default:
      throw new Error('set_recurrence compiled an invalid weekday.');
  }
}

function recurrenceFrequency(value: string): 'daily' | 'weekly' | 'monthly' | 'yearly' {
  switch (value) {
    case 'daily':
    case 'weekly':
    case 'monthly':
    case 'yearly':
      return value;
    default:
      throw new Error('set_recurrence compiled to an unsupported frequency.');
  }
}

export function compile(spec: RecurrenceSpec, itemId: string): Step[] {
  return compileRecurrence(spec, { itemId });
}

export async function execute(
  ports: CompanionPorts,
  steps: readonly Step[],
  signal: AbortSignal,
): Promise<unknown> {
  const step = steps[0];
  if (steps.length !== 1 || step?.kind !== 'setRecurrence' || !('itemId' in step.target)) {
    throw new Error('set_recurrence compiled to an unexpected plan.');
  }
  const weekdays = step.rule.weekdays?.map(weekdayName);
  return ports.core.execute(
    recurrence.setRecurrence(step.target.itemId, {
      freq: recurrenceFrequency(step.rule.freq),
      interval: step.rule.interval,
      weekdays: weekdays ?? null,
      until: step.rule.until,
    }),
    { signal, forceRefresh: true },
  );
}
