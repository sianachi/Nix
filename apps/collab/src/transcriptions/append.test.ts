import { SCHEMA_VERSION, nixSchema } from '@nix/editor-schema';
import type { Pool } from 'pg';
import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { noteStrategy } from '../documents/body-kinds.ts';
import { createTranscriptionAppendService } from './append.ts';
import { CoreTranscriptionError, type CoreTranscriptionClient } from './core.ts';

const JOB = '77777777-7777-4777-8777-777777777777';
const TENANT = '22222222-2222-4222-8222-222222222222';
const PRINCIPAL = '33333333-3333-4333-8333-333333333333';
const WORKSPACE = '44444444-4444-4444-8444-444444444444';
const NOTE = '55555555-5555-4555-8555-555555555555';
const AUDIO = '66666666-6666-4666-8666-666666666666';
const DOC = '88888888-8888-4888-8888-888888888888';

const BODY = {
  durationMillis: 61_000,
  paragraphs: [
    { startMillis: 0, speaker: 'me', text: 'First thing said.' },
    { startMillis: 30_000, speaker: '', text: 'Second thing said.' },
  ],
};

/**
 * The append against a database that is a script: each statement is recognised by its text and
 * answered from the scenario, and every statement is recorded in order. What is being checked is
 * the order of the questions and what each answer turns into - the real merge is the Postgres
 * suite's to prove.
 */
interface Scenario {
  fenceHeld?: boolean;

  /** The items a lock covers, as the lock query would report them. */
  locked?: readonly string[];

  /** The note's stored state, or absent for a note that has no body yet. */
  stored?: Uint8Array;
  alreadyAppended?: boolean;

  /** The version the stored document is pinned to. Defaults to this build's. */
  schemaVersion?: number;
}

function fakeCore(seen: unknown[] = []): CoreTranscriptionClient {
  return {
    authorize: (execution) => {
      seen.push(execution);
      return Promise.resolve({
        tenantId: TENANT,
        principalId: PRINCIPAL,
        workspaceId: WORKSPACE,
        noteItemId: NOTE,
        audioItemId: AUDIO,
        audioTitle: 'Planning call',
        canWrite: true,
      });
    },
  };
}

interface Recorded {
  readonly text: string;
  readonly values: readonly unknown[];
}

function fakePool(scenario: Scenario, log: Recorded[]): Pool {
  const schemaVersion = scenario.schemaVersion ?? SCHEMA_VERSION;
  let created = scenario.stored !== undefined;
  let head = scenario.stored === undefined ? 0 : 1;
  const client = {
    query: (text: string, values: readonly unknown[] = []) => {
      log.push({ text, values });
      let rows: unknown[] = [];
      if (text.includes('nix_fence_worker_execution')) {
        rows = [{ authorized: scenario.fenceHeld ?? true }];
      } else if (text.includes('item_lock')) {
        rows = (scenario.locked ?? []).map((item_id) => ({ item_id }));
      } else if (text.includes('INSERT INTO content_doc')) {
        created = true;
      } else if (text.includes('FROM content_doc')) {
        rows = created
          ? [
              {
                doc_id: DOC,
                item_id: NOTE,
                workspace_id: WORKSPACE,
                schema_version: schemaVersion,
                head_seq: String(head),
              },
            ]
          : [];
      } else if (text.includes('SELECT EXISTS')) {
        rows = [{ found: scenario.alreadyAppended ?? false }];
      } else if (text.includes('FROM content_update')) {
        // Only the stored state is replayed; what this call appends is re-applied by the service
        // from memory, which is all the assertions here need.
        rows =
          scenario.stored !== undefined && values[2] === '0'
            ? [
                {
                  seq: '1',
                  update_bytes: Buffer.from(scenario.stored),
                  actor_id: PRINCIPAL,
                  client_id: 'editor',
                  created_at: new Date(0),
                },
              ]
            : [];
      } else if (text.includes('UPDATE content_doc')) {
        head += 1;
        rows = [{ head_seq: String(head) }];
      }
      return Promise.resolve({ rows, rowCount: rows.length });
    },
    release: () => undefined,
  };
  return { connect: () => Promise.resolve(client) } as unknown as Pool;
}

function untouchablePool(): { pool: Pool; reached: () => boolean } {
  let reached = false;
  return {
    pool: {
      connect: () => {
        reached = true;
        throw new Error('database should not be reached');
      },
    } as unknown as Pool,
    reached: () => reached,
  };
}

function storedNote(): Uint8Array {
  const doc = new Y.Doc();
  prosemirrorJSONToYXmlFragment(
    nixSchema,
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Mine.' }] }] },
    doc.getXmlFragment('default'),
  );
  return Y.encodeStateAsUpdate(doc);
}

/** Where in the log the first statement containing `needle` sits; -1 when it never ran. */
function position(log: readonly Recorded[], needle: string): number {
  return log.findIndex((entry) => entry.text.includes(needle));
}

function appendedUpdates(log: readonly Recorded[]): Recorded[] {
  return log.filter((entry) => entry.text.includes('INSERT INTO content_update'));
}

function request(body: unknown = BODY, jobId = JOB) {
  return { jobId, executionId: 'worker:lease', body };
}

describe('the transcript append service', () => {
  it('fences, checks for an earlier append, checks the locks, then writes - in that order', async () => {
    const log: Recorded[] = [];
    const seen: unknown[] = [];
    const service = createTranscriptionAppendService({
      pool: fakePool({ stored: storedNote() }, log),
      core: fakeCore(seen),
    });

    await expect(service.append(request())).resolves.toEqual({
      appended: true,
      paragraphs: 2,
      noteItemId: NOTE,
    });

    expect(seen).toEqual([{ jobId: JOB, executionId: 'worker:lease' }]);

    const fence = position(log, 'nix_fence_worker_execution');
    const lock = position(log, 'item_lock');
    const earlier = position(log, 'SELECT EXISTS');
    const write = position(log, 'INSERT INTO content_update');
    expect(fence).toBeGreaterThan(-1);
    expect(earlier).toBeGreaterThan(fence);
    expect(lock).toBeGreaterThan(earlier);
    expect(write).toBeGreaterThan(lock);

    // The lock question covers the recording as well as the note.
    expect(log[lock]?.values).toEqual([TENANT, [NOTE, AUDIO]]);

    // The fence is asked about this job, this execution, this kind, as Core's principal.
    expect(log[fence]?.values).toEqual([
      JOB,
      'worker:lease',
      'transcribe.audio',
      TENANT,
      WORKSPACE,
      PRINCIPAL,
    ]);
    expect(log[earlier]?.values).toEqual([TENANT, DOC, `transcription:${JOB}`]);

    const writes = appendedUpdates(log);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.values[4]).toBe(PRINCIPAL);
    expect(writes[0]?.values[5]).toBe(`transcription:${JOB}`);

    // Published on the spot: a snapshot and the search text, holding old and new together.
    expect(position(log, 'INSERT INTO content_snapshot')).toBeGreaterThan(write);
    const search = log.find((entry) => entry.text.includes('INSERT INTO item_search'));
    expect(search?.values[3]).toContain('Mine.');
    expect(search?.values[3]).toContain('First thing said.');
  });

  it('creates the body of a note nobody has opened and writes the section into it', async () => {
    const log: Recorded[] = [];
    const service = createTranscriptionAppendService({
      pool: fakePool({}, log),
      core: fakeCore(),
      newDocId: () => DOC,
    });

    await expect(service.append(request())).resolves.toMatchObject({ appended: true });

    // No log to look in before the body exists, so the earlier-append question is not asked.
    expect(position(log, 'SELECT EXISTS')).toBe(-1);
    expect(position(log, 'INSERT INTO content_doc')).toBeGreaterThan(position(log, 'item_lock'));
    expect(position(log, 'item_lock')).toBeGreaterThan(position(log, 'FROM content_doc'));

    const written = new Y.Doc();
    Y.applyUpdate(written, new Uint8Array(appendedUpdates(log)[0]?.values[3] as Buffer));
    expect(noteStrategy.materialize(written).plaintext.split('\n')).toEqual([
      'Transcript',
      'From Planning call, 1:01 long.',
      '[0:00] Me: First thing said.',
      '[0:30] Second thing said.',
    ]);
  });

  it('writes nothing when this job has already appended', async () => {
    const log: Recorded[] = [];
    const service = createTranscriptionAppendService({
      pool: fakePool({ stored: storedNote(), alreadyAppended: true }, log),
      core: fakeCore(),
    });

    await expect(service.append(request())).resolves.toEqual({
      appended: false,
      paragraphs: 2,
      noteItemId: NOTE,
    });
    expect(appendedUpdates(log)).toHaveLength(0);
    expect(position(log, 'COMMIT')).toBeGreaterThan(-1);
  });

  it('refuses when the execution no longer holds the lease, before reading anything else', async () => {
    const log: Recorded[] = [];
    const service = createTranscriptionAppendService({
      pool: fakePool({ stored: storedNote(), fenceHeld: false }, log),
      core: fakeCore(),
    });

    await expect(service.append(request())).rejects.toMatchObject({
      status: 409,
      code: 'transcription_execution_lost',
    });
    expect(position(log, 'item_lock')).toBe(-1);
    expect(position(log, 'content_doc')).toBe(-1);
    expect(position(log, 'ROLLBACK')).toBeGreaterThan(-1);
  });

  it.each([
    ['the note', [NOTE], 'note'],
    ['the recording', [AUDIO], 'recording'],
    ['both', [NOTE, AUDIO], 'note'],
  ])(
    'refuses when a lock covers %s, without loading or writing the body',
    async (_name, locked, named) => {
      const log: Recorded[] = [];
      const service = createTranscriptionAppendService({
        pool: fakePool({ stored: storedNote(), locked }, log),
        core: fakeCore(),
      });

      await expect(service.append(request())).rejects.toMatchObject({
        status: 409,
        code: 'transcription_note_locked',
        message: expect.stringContaining(named) as unknown,
      });
      expect(position(log, 'content_snapshot')).toBe(-1);
      expect(position(log, 'UPDATE content_doc')).toBe(-1);
      expect(appendedUpdates(log)).toHaveLength(0);
      expect(position(log, 'ROLLBACK')).toBeGreaterThan(-1);
    },
  );

  it('does not create a body for a locked recording whose note has never been opened', async () => {
    const log: Recorded[] = [];
    const service = createTranscriptionAppendService({
      pool: fakePool({ locked: [AUDIO] }, log),
      core: fakeCore(),
    });

    await expect(service.append(request())).rejects.toMatchObject({
      code: 'transcription_note_locked',
    });
    expect(position(log, 'INSERT INTO content_doc')).toBe(-1);
  });

  it('tells a retry its append landed even when the note was locked afterwards', async () => {
    const log: Recorded[] = [];
    const service = createTranscriptionAppendService({
      pool: fakePool({ stored: storedNote(), alreadyAppended: true, locked: [NOTE, AUDIO] }, log),
      core: fakeCore(),
    });

    await expect(service.append(request())).resolves.toMatchObject({ appended: false });
    // Answered before the locks were even asked about.
    expect(position(log, 'item_lock')).toBe(-1);
  });

  it.each([
    ['a canvas', (doc: Y.Doc) => doc.getMap('elements').set('a', { id: 'a' })],
    ['a sheet', (doc: Y.Doc) => doc.getMap('sheet-cells').set('A1', { raw: '1' })],
  ])('refuses %s rather than writing prose into it', async (_name, fill) => {
    const other = new Y.Doc();
    fill(other);
    const log: Recorded[] = [];
    const service = createTranscriptionAppendService({
      pool: fakePool({ stored: Y.encodeStateAsUpdate(other) }, log),
      core: fakeCore(),
    });

    await expect(service.append(request())).rejects.toMatchObject({
      status: 409,
      code: 'transcription_note_unsupported',
    });
    expect(appendedUpdates(log)).toHaveLength(0);
  });

  it('refuses a merged document over the node ceiling and rolls back', async () => {
    const crowded = new Y.Doc();
    const fragment = crowded.getXmlFragment('default');
    fragment.insert(
      0,
      Array.from({ length: 100_000 }, () => new Y.XmlElement('paragraph')),
    );
    const log: Recorded[] = [];
    const service = createTranscriptionAppendService({
      pool: fakePool({ stored: Y.encodeStateAsUpdate(crowded) }, log),
      core: fakeCore(),
    });

    await expect(service.append(request())).rejects.toMatchObject({
      status: 413,
      code: 'transcription_too_large',
    });
    expect(appendedUpdates(log)).toHaveLength(0);
    expect(position(log, 'ROLLBACK')).toBeGreaterThan(-1);
  });

  it('refuses a note pinned below the schema a reference needs, saying which pin', async () => {
    const log: Recorded[] = [];
    const service = createTranscriptionAppendService({
      pool: fakePool({ stored: storedNote(), schemaVersion: 1 }, log),
      core: fakeCore(),
    });

    await expect(service.append(request())).rejects.toMatchObject({
      status: 409,
      code: 'transcription_note_unsupported',
      message: expect.stringContaining('pinned to 1') as unknown,
    });
    expect(appendedUpdates(log)).toHaveLength(0);
  });

  it('splits a transcript over the batch budget into numbered updates and publishes once', async () => {
    const log: Recorded[] = [];
    const service = createTranscriptionAppendService({
      pool: fakePool({ stored: storedNote() }, log),
      core: fakeCore(),
      batchBytes: 2_000,
    });
    const paragraphs = Array.from({ length: 6 }, (_, index) => ({
      startMillis: index * 1_000,
      speaker: '',
      text: `Line ${String(index)} ${'x'.repeat(400)}`,
    }));

    await expect(
      service.append(request({ durationMillis: 6_000, paragraphs })),
    ).resolves.toMatchObject({ appended: true, paragraphs: 6 });

    // 1168 bytes a paragraph against a 2000-byte budget: one paragraph per update.
    expect(appendedUpdates(log).map((entry) => entry.values[5])).toEqual([
      `transcription:${JOB}`,
      `transcription:${JOB}:2`,
      `transcription:${JOB}:3`,
      `transcription:${JOB}:4`,
      `transcription:${JOB}:5`,
      `transcription:${JOB}:6`,
    ]);
    expect(log.filter((entry) => entry.text.includes('INSERT INTO content_snapshot'))).toHaveLength(
      1,
    );
    const lastWrite = log.findLastIndex((entry) =>
      entry.text.includes('INSERT INTO content_update'),
    );
    expect(position(log, 'INSERT INTO content_snapshot')).toBeGreaterThan(lastWrite);
  });

  it('passes a Core refusal through without reaching the database', async () => {
    const { pool, reached } = untouchablePool();
    const service = createTranscriptionAppendService({
      pool,
      core: {
        authorize: () =>
          Promise.reject(
            new CoreTranscriptionError(409, 'transcription_execution_lost', 'Lease lost.'),
          ),
      },
    });

    await expect(service.append(request())).rejects.toMatchObject({
      status: 409,
      code: 'transcription_execution_lost',
    });
    expect(reached()).toBe(false);
  });

  it.each([
    ['no body', null],
    ['an array', []],
    ['a negative duration', { ...BODY, durationMillis: -1 }],
    ['a fractional duration', { ...BODY, durationMillis: 1.5 }],
    ['a duration sent as text', { ...BODY, durationMillis: '61000' }],
    ['paragraphs that are not an array', { ...BODY, paragraphs: {} }],
    [
      'too many paragraphs',
      {
        durationMillis: 1,
        paragraphs: Array.from({ length: 5_001 }, () => BODY.paragraphs[0]),
      },
    ],
    ['a paragraph that is not an object', { ...BODY, paragraphs: ['text'] }],
    ['a negative start', { ...BODY, paragraphs: [{ startMillis: -5, speaker: '', text: 'a' }] }],
    [
      'an unknown speaker',
      { ...BODY, paragraphs: [{ startMillis: 0, speaker: 'Ada', text: 'a' }] },
    ],
    ['a missing speaker', { ...BODY, paragraphs: [{ startMillis: 0, text: 'a' }] }],
    ['empty text', { ...BODY, paragraphs: [{ startMillis: 0, speaker: '', text: '' }] }],
    [
      'text over the limit',
      { ...BODY, paragraphs: [{ startMillis: 0, speaker: '', text: 'a'.repeat(4_001) }] },
    ],
    [
      'text holding a NUL',
      { ...BODY, paragraphs: [{ startMillis: 0, speaker: '', text: 'a\u0000b' }] },
    ],
  ])('refuses %s before asking Core or the database', async (_name, body) => {
    const { pool, reached } = untouchablePool();
    const seen: unknown[] = [];
    const service = createTranscriptionAppendService({ pool, core: fakeCore(seen) });

    await expect(service.append(request(body))).rejects.toMatchObject({
      status: 400,
      code: 'transcription_invalid',
    });
    expect(seen).toEqual([]);
    expect(reached()).toBe(false);
  });

  it('never repeats transcript text in a refusal', async () => {
    const { pool } = untouchablePool();
    const service = createTranscriptionAppendService({ pool, core: fakeCore() });
    const secret = 'the acquisition closes on Friday';

    const refusal: unknown = await service
      .append(
        request({
          durationMillis: 1,
          paragraphs: [{ startMillis: 0, speaker: 'nobody', text: secret }],
        }),
      )
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).not.toContain(secret);
  });

  it('counts the text limit in characters, not UTF-16 units, and accepts an empty transcript', async () => {
    const log: Recorded[] = [];
    const service = createTranscriptionAppendService({
      pool: fakePool({ stored: storedNote() }, log),
      core: fakeCore(),
    });

    // 4000 characters that are 8000 UTF-16 units: what a rune-counting worker calls 4000.
    const astral = '\u{1D11E}'.repeat(4_000);
    await expect(
      service.append(
        request({
          durationMillis: 1,
          paragraphs: [{ startMillis: 0, speaker: '', text: astral }],
        }),
      ),
    ).resolves.toMatchObject({ appended: true, paragraphs: 1 });

    await expect(
      service.append(request({ durationMillis: 0, paragraphs: [] })),
    ).resolves.toMatchObject({ appended: true, paragraphs: 0 });
  });

  it('refuses a job identifier that is not a uuid as not found', async () => {
    const { pool, reached } = untouchablePool();
    const seen: unknown[] = [];
    const service = createTranscriptionAppendService({ pool, core: fakeCore(seen) });

    await expect(service.append(request(BODY, "x' OR 1=1"))).rejects.toMatchObject({
      status: 404,
      code: 'transcription_not_found',
    });
    expect(seen).toEqual([]);
    expect(reached()).toBe(false);
  });
});
