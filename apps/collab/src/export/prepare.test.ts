import { describe, expect, it } from 'vitest';

import { readAtSeq, readExportedAt } from './prepare.ts';

describe('durable export timestamps', () => {
  it('normalizes a bounded RFC 3339 job timestamp', () => {
    expect(readExportedAt('2026-09-01T12:34:56.1234567+00:00')?.toISOString()).toBe(
      '2026-09-01T12:34:56.123Z',
    );
  });

  it.each([
    '',
    '2026-09-01',
    'not-a-date',
    '2026-09-01T12:34:56',
    '2026-99-99T99:99:99Z',
    '2026-09-01T12:34:56Z\nignored',
  ])('rejects an invalid job timestamp: %s', (value) => {
    expect(readExportedAt(value)).toBeNull();
  });
});

describe('pinned content positions', () => {
  it('reads a plain non-negative integer', () => {
    expect(readAtSeq('0')).toBe(0);
    expect(readAtSeq('4242')).toBe(4242);
  });

  it.each(['', '-1', '1.5', '1e3', ' 1', '0x10', '1234567890123456', 'abc'])(
    'rejects %j',
    (value) => {
      expect(readAtSeq(value)).toBeNull();
    },
  );
});
