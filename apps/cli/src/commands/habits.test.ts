import { describe, expect, it } from 'vitest';
import { outputOptions } from '../output.ts';
import { checkIn, setHabit, setHabitStatus } from './habits.ts';

const ITEM = '11111111-1111-4111-8111-111111111111';
const OUTPUT = outputOptions(true, { isTTY: false });

describe('habit CLI validation', () => {
  it('rejects unknown lifecycle states before opening a session', async () => {
    await expect(setHabitStatus(undefined, ITEM, 'deleted', OUTPUT)).rejects.toThrow(
      'Status must be active, paused, or archived',
    );
  });

  it('rejects malformed weekday tokens before opening a session', async () => {
    await expect(
      setHabit(
        undefined,
        ITEM,
        {
          frequency: 'weekly',
          weekdays: '1oops',
          timezone: 'Europe/London',
          startDate: '2026-09-14',
          target: '1',
          unit: 'minutes',
        },
        OUTPUT,
      ),
    ).rejects.toThrow('--weekdays');
  });

  it('rejects zero targets locally', async () => {
    await expect(
      setHabit(
        undefined,
        ITEM,
        {
          frequency: 'daily',
          timezone: 'Europe/London',
          startDate: '2026-09-14',
          target: '0',
          unit: 'minutes',
        },
        OUTPUT,
      ),
    ).rejects.toThrow('--target');
  });

  it('rejects negative quantities before opening a session', async () => {
    await expect(
      checkIn(undefined, ITEM, { on: '2026-09-14', quantity: '-1', completed: true }, OUTPUT),
    ).rejects.toThrow('--quantity');
  });
});
