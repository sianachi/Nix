import { describe, expect, it } from 'vitest';

import { REVISION_GAP_MS, attachNames, coalesceRevisions } from './history.ts';
import type { UpdateRow } from './documents.ts';

function row(
  seq: number,
  actorId: string,
  createdAt: string,
  extra: Partial<UpdateRow> = {},
): UpdateRow {
  return {
    seq: String(seq),
    update_bytes: Buffer.alloc(0),
    actor_id: actorId,
    client_id: 'client',
    created_at: new Date(createdAt),
    ...extra,
  };
}

describe('coalesceRevisions', () => {
  it('groups consecutive updates by one actor into a single revision', () => {
    const rows = [
      row(1, 'alice', '2026-01-01T00:00:00.000Z'),
      row(2, 'alice', '2026-01-01T00:00:05.000Z'),
      row(3, 'alice', '2026-01-01T00:00:10.000Z'),
    ];

    expect(coalesceRevisions(rows)).toEqual([
      {
        seq: 3,
        fromSeq: 1,
        actorId: 'alice',
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:00:10.000Z',
        updateCount: 3,
        name: null,
      },
    ]);
  });

  it('starts a new revision when the gap exceeds the threshold', () => {
    const rows = [
      row(1, 'alice', '2026-01-01T00:00:00.000Z'),
      row(2, 'alice', '2026-01-01T00:00:05.000Z'),
      // Just over ten minutes after the previous update.
      row(
        3,
        'alice',
        new Date(
          new Date('2026-01-01T00:00:05.000Z').getTime() + REVISION_GAP_MS + 1,
        ).toISOString(),
      ),
    ];

    const revisions = coalesceRevisions(rows);

    expect(revisions).toHaveLength(2);
    expect(revisions[0]).toMatchObject({ fromSeq: 1, seq: 2, updateCount: 2 });
    expect(revisions[1]).toMatchObject({ fromSeq: 3, seq: 3, updateCount: 1 });
  });

  it('keeps a revision together when the gap is exactly at the threshold', () => {
    const start = new Date('2026-01-01T00:00:00.000Z');
    const rows = [
      row(1, 'alice', start.toISOString()),
      row(2, 'alice', new Date(start.getTime() + REVISION_GAP_MS).toISOString()),
    ];

    expect(coalesceRevisions(rows)).toHaveLength(1);
  });

  it('splits a run when the actor changes, even with no gap at all', () => {
    const rows = [
      row(1, 'alice', '2026-01-01T00:00:00.000Z'),
      row(2, 'bob', '2026-01-01T00:00:00.000Z'),
      row(3, 'bob', '2026-01-01T00:00:01.000Z'),
    ];

    const revisions = coalesceRevisions(rows);

    expect(revisions).toEqual([
      {
        seq: 1,
        fromSeq: 1,
        actorId: 'alice',
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:00:00.000Z',
        updateCount: 1,
        name: null,
      },
      {
        seq: 3,
        fromSeq: 2,
        actorId: 'bob',
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:00:01.000Z',
        updateCount: 2,
        name: null,
      },
    ]);
  });

  it('accepts a custom gap', () => {
    const rows = [
      row(1, 'alice', '2026-01-01T00:00:00.000Z'),
      row(2, 'alice', '2026-01-01T00:00:02.000Z'),
    ];

    // A one-second gap threshold splits what the default ten-minute one would keep together.
    expect(coalesceRevisions(rows, 1000)).toHaveLength(2);
  });

  it('returns nothing for an empty log', () => {
    expect(coalesceRevisions([])).toEqual([]);
  });

  it('every revision carries no name until one is attached', () => {
    const rows = [row(1, 'alice', '2026-01-01T00:00:00.000Z')];

    for (const revision of coalesceRevisions(rows)) {
      expect(revision.name).toBeNull();
    }
  });
});

describe('attachNames', () => {
  it('attaches a name to the revision whose last seq matches', () => {
    const revisions = coalesceRevisions([
      row(1, 'alice', '2026-01-01T00:00:00.000Z'),
      row(2, 'alice', '2026-01-01T00:00:01.000Z'),
      row(3, 'bob', '2026-01-01T00:05:00.000Z'),
    ]);

    const named = attachNames(revisions, new Map([['2', 'Draft one']]));

    expect(named.map((revision) => revision.name)).toEqual(['Draft one', null]);
  });

  it('leaves revisions with no matching name untouched', () => {
    const revisions = coalesceRevisions([row(1, 'alice', '2026-01-01T00:00:00.000Z')]);

    expect(attachNames(revisions, new Map())).toEqual(revisions);
  });
});
