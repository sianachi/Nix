import { describe, expect, it } from 'vitest';
import {
  localDailyNoteDate,
  parseDailyNoteDate,
  shiftDailyNoteDate,
} from '../../daily-notes/daily-note';
process.env.TZ = 'Europe/London';
describe('local daily note dates', () => {
  it('uses the local rollover hour through the spring DST transition', () => {
    expect(localDailyNoteDate(new Date('2026-03-29T02:30:00+01:00'), 3)).toBe('2026-03-28');
    expect(localDailyNoteDate(new Date('2026-03-29T03:30:00+01:00'), 3)).toBe('2026-03-29');
  });
  it('shifts across year and leap-day boundaries and refuses impossible dates', () => {
    expect(shiftDailyNoteDate('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftDailyNoteDate('2024-02-28', 1)).toBe('2024-02-29');
    expect(parseDailyNoteDate('2026-02-29')).toBeNull();
    expect(parseDailyNoteDate('2026-02-31')).toBeNull();
  });
});
