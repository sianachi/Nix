import { randomUUID } from 'node:crypto';

import { nixSchema } from '@nix/editor-schema';
import type { Pool } from 'pg';
import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { findDocByItem } from '../db/documents.ts';
import { withTenantScope } from '../db/tenant-scope.ts';
import {
  DB_TESTS_ENABLED,
  TENANTS,
  adminPool,
  clearContent,
  collabPool,
  seedTenants,
  type TestTenant,
} from '../db/testing.ts';
import { noteStrategy } from '../documents/body-kinds.ts';
import { FRAGMENT_NAME, applyUpdate, loadDocument, openDocument } from '../documents/service.ts';
import { createTranscriptionAppendService, type TranscriptionAppendService } from './append.ts';
import type { CoreTranscriptionClient } from './core.ts';

/**
 * The transcript append against real Postgres, as the collaboration role.
 *
 * What only a database can show: that the fence function answers for a `transcribe.audio` job
 * and is callable by this service's role, that an append and somebody's typing both survive
 * each other, that a retry and a re-transcription do what the route promises, and that the
 * transcript reaches search without an editor ever opening the note.
 *
 * Requires the development stack, like the other suites beside `db/testing.ts`.
 */
describe.skipIf(!DB_TESTS_ENABLED)('the transcript append, against Postgres', () => {
  const tenant = TENANTS.alpha;
  const EXECUTION = 'speech-worker:test-lease';
  let pool: Pool;
  let service: TranscriptionAppendService;

  /** A second recording and a folder to put a recording under; seeded here, removed afterwards. */
  const SECOND_AUDIO = 'c1000000-0000-4000-8000-0000000000b1';
  const FOLDER = 'c1000000-0000-4000-8000-0000000000b2';

  /** Which recording each job transcribes; a job not listed transcribes the seeded target item. */
  const recordings = new Map<string, { audioItemId: string; audioTitle: string }>();

  const core: CoreTranscriptionClient = {
    authorize: ({ jobId }) =>
      Promise.resolve({
        tenantId: tenant.tenantId,
        principalId: tenant.principalId,
        workspaceId: tenant.workspaceId,
        noteItemId: tenant.itemId,
        // The seeded second item stands in for the recording, so the reference has a real target
        // and the backlink edge can land.
        audioItemId: tenant.targetItemId,
        audioTitle: 'Planning call',
        ...recordings.get(jobId),
        canWrite: true,
      }),
  };

  async function seedExtraItems(): Promise<void> {
    const admin = adminPool();
    try {
      for (const [itemId, title] of [
        [SECOND_AUDIO, 'Retro'],
        [FOLDER, 'Recordings'],
      ] as const) {
        await admin.query(
          `INSERT INTO item
               (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                purge_after, created_by, last_modified_by, created_at, last_modified_at)
           VALUES ($1, $2, $3, 'note', NULL, 1000, $5::jsonb, 'active', NULL, $4, $4, now(), now())
           ON CONFLICT (id) DO NOTHING`,
          [
            itemId,
            tenant.tenantId,
            tenant.workspaceId,
            tenant.principalId,
            JSON.stringify({ title }),
          ],
        );
        await admin.query(
          `INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
           VALUES ($1, $1, $2, $3, 0)
           ON CONFLICT DO NOTHING`,
          [itemId, tenant.tenantId, tenant.workspaceId],
        );
      }
    } finally {
      await admin.end();
    }
  }

  async function removeExtraItems(): Promise<void> {
    const admin = adminPool();
    try {
      const extra = [SECOND_AUDIO, FOLDER];
      await admin.query(
        'DELETE FROM item_closure WHERE descendant_id = ANY($1) OR ancestor_id = ANY($1)',
        [extra],
      );
      await admin.query('DELETE FROM item WHERE id = ANY($1)', [extra]);
    } finally {
      await admin.end();
    }
  }

  async function clearJobsAndLocks(): Promise<void> {
    const admin = adminPool();
    try {
      const tenants = [TENANTS.alpha.tenantId, TENANTS.beta.tenantId];
      await admin.query('DELETE FROM worker_job WHERE tenant_id = ANY($1)', [tenants]);
      await admin.query('DELETE FROM item_lock WHERE tenant_id = ANY($1)', [tenants]);
      // The ancestor edges a test adds to put a recording inside a folder; the self edges stay.
      await admin.query('DELETE FROM item_closure WHERE tenant_id = ANY($1) AND depth > 0', [
        tenants,
      ]);
    } finally {
      await admin.end();
    }
  }

  beforeAll(async () => {
    pool = collabPool();
    service = createTranscriptionAppendService({ pool, core });
    await seedTenants();
    await seedExtraItems();
  });

  afterAll(async () => {
    await clearContent();
    await clearJobsAndLocks();
    await removeExtraItems();
    await pool.end();
  });

  beforeEach(async () => {
    recordings.clear();
    await clearContent();
    await clearJobsAndLocks();
  });

  /** A running job leased to this suite's execution, as Core would have left it. */
  async function leasedJob(
    overrides: { kind?: string; owner?: string; leaseSeconds?: number } = {},
  ): Promise<string> {
    const jobId = randomUUID();
    const admin = adminPool();
    try {
      await admin.query(
        `INSERT INTO worker_job
             (job_id, tenant_id, workspace_id, actor_id, kind, idempotency_key, payload, status,
              attempts, lease_owner, lease_until, cancellation_requested, created_at, started_at,
              updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, 'running', 1, $7,
                 now() + make_interval(secs => $8), false, now(), now(), now())`,
        [
          jobId,
          tenant.tenantId,
          tenant.workspaceId,
          tenant.principalId,
          overrides.kind ?? 'transcribe.audio',
          `test-${jobId}`,
          overrides.owner ?? EXECUTION,
          overrides.leaseSeconds ?? 300,
        ],
      );
    } finally {
      await admin.end();
    }
    return jobId;
  }

  function scopeOf(scoped: TestTenant) {
    return { tenantId: scoped.tenantId, principalId: scoped.principalId };
  }

  /** Writes the note's starting content the way an editor would, and returns that editor. */
  async function noteWith(lines: readonly string[]): Promise<Y.Doc> {
    const editor = new Y.Doc();
    prosemirrorJSONToYXmlFragment(
      nixSchema,
      {
        type: 'doc',
        content: lines.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
      },
      editor.getXmlFragment(FRAGMENT_NAME),
    );
    await userUpdate(Y.encodeStateAsUpdate(editor));
    return editor;
  }

  async function userUpdate(updateBytes: Uint8Array): Promise<void> {
    const applied = await withTenantScope(pool, scopeOf(tenant), async (sql) => {
      const doc = await openDocument(
        sql,
        tenant.tenantId,
        tenant.itemId,
        tenant.workspaceId,
        () => tenant.docId,
      );
      if (doc === null) throw new Error('The document was not created.');
      return await applyUpdate(sql, {
        tenantId: tenant.tenantId,
        doc,
        updateBytes,
        actorId: tenant.principalId,
        clientId: 'editor',
        snapshotEvery: 1,
      });
    });
    if (!applied.ok) throw new Error(`The user's update was refused: ${applied.error.code}`);
  }

  /** One update that types `text` at the end of the editor's first paragraph. */
  function typeInto(editor: Y.Doc, text: string): Uint8Array {
    const before = Y.encodeStateVector(editor);
    const first = editor.getXmlFragment(FRAGMENT_NAME).get(0) as Y.XmlElement;
    const run = first.get(0) as Y.XmlText;
    run.insert(run.length, text);
    return Y.encodeStateAsUpdate(editor, before);
  }

  /** The note as the log says it is, one line per top-level node. */
  async function storedLines(): Promise<string[]> {
    return await withTenantScope(pool, scopeOf(tenant), async (sql) => {
      const doc = await findDocByItem(sql, tenant.tenantId, tenant.itemId);
      if (doc === null) return [];
      const state = await loadDocument(sql, tenant.tenantId, doc);
      return noteStrategy.materialize(state).plaintext.split('\n');
    });
  }

  async function searchText(): Promise<string> {
    return await withTenantScope(pool, scopeOf(tenant), async (sql) => {
      const { rows } = await sql.query<{ body_text: string }>(
        'SELECT body_text FROM item_search WHERE tenant_id = $1 AND item_id = $2',
        [tenant.tenantId, tenant.itemId],
      );
      return rows[0]?.body_text ?? '';
    });
  }

  function transcript(...lines: string[]) {
    return {
      durationMillis: 125_000,
      paragraphs: lines.map((text, index) => ({
        startMillis: index * 30_000,
        speaker: index % 2 === 0 ? 'me' : 'others',
        text,
      })),
    };
  }

  function append(jobId: string, body: unknown, executionId = EXECUTION) {
    return service.append({ jobId, executionId, body });
  }

  /** A leased job that transcribes the second recording rather than the seeded one. */
  async function leasedJobForSecondRecording(): Promise<string> {
    const jobId = await leasedJob();
    recordings.set(jobId, { audioItemId: SECOND_AUDIO, audioTitle: 'Retro' });
    return jobId;
  }

  /** The note's top-level nodes as the log says they are, each serialised on its own. */
  async function storedNodes(): Promise<string[]> {
    return await withTenantScope(pool, scopeOf(tenant), async (sql) => {
      const doc = await findDocByItem(sql, tenant.tenantId, tenant.itemId);
      if (doc === null) return [];
      const state = await loadDocument(sql, tenant.tenantId, doc);
      const json = noteStrategy.materialize(state).json as { content?: unknown[] };
      return (json.content ?? []).map((node) => JSON.stringify(node));
    });
  }

  /** Types a new paragraph at the very end of the note, as an editor that is up to date would. */
  async function typeAtEnd(text: string): Promise<void> {
    const editor = new Y.Doc();
    Y.applyUpdate(
      editor,
      await withTenantScope(pool, scopeOf(tenant), async (sql) => {
        const doc = await findDocByItem(sql, tenant.tenantId, tenant.itemId);
        if (doc === null) throw new Error('Expected the document.');
        return Y.encodeStateAsUpdate(await loadDocument(sql, tenant.tenantId, doc));
      }),
    );
    const before = Y.encodeStateVector(editor);
    const fragment = editor.getXmlFragment(FRAGMENT_NAME);
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.insert(0, [new Y.XmlText(text)]);
    fragment.insert(fragment.length, [paragraph]);
    await userUpdate(Y.encodeStateAsUpdate(editor, before));
  }

  async function lock(itemId: string): Promise<void> {
    const admin = adminPool();
    try {
      await admin.query(
        `INSERT INTO item_lock (item_id, tenant_id, password_hash, locked_by, locked_at)
         VALUES ($1, $2, $3, $4, now())`,
        [
          itemId,
          tenant.tenantId,
          'pbkdf2-sha256$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
          tenant.principalId,
        ],
      );
    } finally {
      await admin.end();
    }
  }

  const HEAD = ['Transcript', 'From Planning call, 2:05 long.'];
  const RETRO_HEAD = ['Transcript', 'From Retro, 2:05 long.'];

  it("keeps each recording's section intact when the other is transcribed again", async () => {
    await noteWith(['Two meetings.']);
    await append(await leasedJob(), transcript('Planning, first pass.', 'Rough.'));
    await append(await leasedJobForSecondRecording(), transcript('Retro, first pass.'));

    expect(await storedLines()).toEqual([
      'Two meetings.',
      ...HEAD,
      '[0:00] Me: Planning, first pass.',
      '[0:30] Others: Rough.',
      ...RETRO_HEAD,
      '[0:00] Me: Retro, first pass.',
    ]);

    // Transcribe the second recording again: the first one's four nodes are exactly as stored.
    const planningBefore = (await storedNodes()).slice(1, 5);
    await expect(
      append(await leasedJobForSecondRecording(), transcript('Retro, redone.', 'Longer now.')),
    ).resolves.toMatchObject({ appended: true });
    expect((await storedNodes()).slice(1, 5)).toEqual(planningBefore);
    expect(await storedLines()).toEqual([
      'Two meetings.',
      ...HEAD,
      '[0:00] Me: Planning, first pass.',
      '[0:30] Others: Rough.',
      ...RETRO_HEAD,
      '[0:00] Me: Retro, redone.',
      '[0:30] Others: Longer now.',
    ]);

    // And the first again: the second one's four nodes are exactly as stored, and still last.
    const retroBefore = (await storedNodes()).slice(-4);
    await expect(append(await leasedJob(), transcript('Planning, redone.'))).resolves.toMatchObject(
      { appended: true },
    );
    expect((await storedNodes()).slice(-4)).toEqual(retroBefore);
    expect(await storedLines()).toEqual([
      'Two meetings.',
      ...HEAD,
      '[0:00] Me: Planning, redone.',
      ...RETRO_HEAD,
      '[0:00] Me: Retro, redone.',
      '[0:30] Others: Longer now.',
    ]);
  });

  it('keeps what somebody typed directly under a transcript when it is transcribed again', async () => {
    await noteWith(['Agenda.']);
    await append(await leasedJob(), transcript('First pass.', 'Rough.'));
    await typeAtEnd('My take: ship it.');

    await expect(append(await leasedJob(), transcript('Second pass.'))).resolves.toMatchObject({
      appended: true,
    });

    expect(await storedLines()).toEqual([
      'Agenda.',
      ...HEAD,
      '[0:00] Me: Second pass.',
      'My take: ship it.',
    ]);
  });

  it.each([
    ['the recording itself', async () => lock(tenant.targetItemId)],
    [
      'a folder the recording was moved under',
      async () => {
        const admin = adminPool();
        try {
          await admin.query(
            `INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
             VALUES ($1, $2, $3, $4, 1)`,
            [tenant.targetItemId, FOLDER, tenant.tenantId, tenant.workspaceId],
          );
        } finally {
          await admin.end();
        }
        await lock(FOLDER);
      },
    ],
  ])(
    'refuses when a lock lands on %s after authorization, leaving the note unchanged',
    async (_name, lockIt) => {
      await noteWith(['Open notes.']);
      const jobId = await leasedJob();
      const before = await storedNodes();

      // Core said yes when the job was made; the lock arrives while the audio is being transcribed.
      await lockIt();

      await expect(append(jobId, transcript('Said behind a lock.'))).rejects.toMatchObject({
        status: 409,
        code: 'transcription_note_locked',
      });
      expect(await storedNodes()).toEqual(before);
      expect(await searchText()).not.toContain('Said behind a lock.');
    },
  );

  it('tells a retry its append landed even though the note was locked afterwards', async () => {
    await noteWith(['Agenda.']);
    const jobId = await leasedJob();
    await append(jobId, transcript('Once.'));
    const after = await storedNodes();

    await lock(tenant.itemId);

    await expect(append(jobId, transcript('Once.'))).resolves.toMatchObject({ appended: false });
    expect(await storedNodes()).toEqual(after);
    // A different job is a new write, and that one the lock refuses.
    await expect(append(await leasedJob(), transcript('Again.'))).rejects.toMatchObject({
      code: 'transcription_note_locked',
    });
  });

  it('merges with an edit made against the note as it was before the append', async () => {
    const editor = await noteWith(['Agenda.', 'Closing thoughts.']);
    const jobId = await leasedJob();

    // Typed in a tab that has not heard about the transcript yet.
    const typed = typeInto(editor, ' Budget first.');

    await expect(append(jobId, transcript('Shall we start?', 'Yes.'))).resolves.toEqual({
      appended: true,
      paragraphs: 2,
      noteItemId: tenant.itemId,
    });
    await userUpdate(typed);

    expect(await storedLines()).toEqual([
      'Agenda. Budget first.',
      'Closing thoughts.',
      ...HEAD,
      '[0:00] Me: Shall we start?',
      '[0:30] Others: Yes.',
    ]);
  });

  it('merges with an edit committing at the same moment', async () => {
    const editor = await noteWith(['Agenda.']);
    const jobId = await leasedJob();
    const typed = typeInto(editor, ' Typed during the append.');

    await Promise.all([append(jobId, transcript('Shall we start?')), userUpdate(typed)]);

    const lines = await storedLines();
    expect(lines).toEqual([
      'Agenda. Typed during the append.',
      ...HEAD,
      '[0:00] Me: Shall we start?',
    ]);

    // Whichever committed last published the snapshot, and it must hold both.
    const text = await searchText();
    expect(text).toContain('Typed during the append.');
    expect(text).toContain('Shall we start?');
  });

  it('does nothing when the same job calls again', async () => {
    await noteWith(['Agenda.']);
    const jobId = await leasedJob();

    await expect(append(jobId, transcript('Once.'))).resolves.toMatchObject({ appended: true });
    const after = await storedLines();

    // The retry carries different text on purpose: nothing of it may land.
    await expect(append(jobId, transcript('Twice.', 'Thrice.'))).resolves.toEqual({
      appended: false,
      paragraphs: 2,
      noteItemId: tenant.itemId,
    });

    expect(await storedLines()).toEqual(after);
    expect(after).toEqual(['Agenda.', ...HEAD, '[0:00] Me: Once.']);
  });

  it('replaces the earlier section, and only that, when a new job transcribes again', async () => {
    const editor = await noteWith(['Agenda.']);
    await append(await leasedJob(), transcript('First pass.', 'Rough.'));

    // Somebody writes under the transcript, in a section of their own, before the second pass.
    Y.applyUpdate(
      editor,
      await withTenantScope(pool, scopeOf(tenant), async (sql) => {
        const doc = await findDocByItem(sql, tenant.tenantId, tenant.itemId);
        if (doc === null) throw new Error('Expected the document.');
        return Y.encodeStateAsUpdate(await loadDocument(sql, tenant.tenantId, doc));
      }),
    );
    const before = Y.encodeStateVector(editor);
    const fragment = editor.getXmlFragment(FRAGMENT_NAME);
    const scratch = new Y.Doc();
    prosemirrorJSONToYXmlFragment(
      nixSchema,
      {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Actions' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Send the minutes.' }] },
        ],
      },
      scratch.getXmlFragment('scratch'),
    );
    fragment.insert(
      fragment.length,
      scratch
        .getXmlFragment('scratch')
        .toArray()
        .map((node) => (node as Y.XmlElement).clone()),
    );
    await userUpdate(Y.encodeStateAsUpdate(editor, before));

    await expect(
      append(await leasedJob(), transcript('Second pass.', 'Cleaner.', 'Longer.')),
    ).resolves.toMatchObject({ appended: true, paragraphs: 3 });

    expect(await storedLines()).toEqual([
      'Agenda.',
      ...HEAD,
      '[0:00] Me: Second pass.',
      '[0:30] Others: Cleaner.',
      '[1:00] Me: Longer.',
      'Actions',
      'Send the minutes.',
    ]);
  });

  it('publishes the transcript to search and the recording to backlinks', async () => {
    const jobId = await leasedJob();

    // No body yet: nobody has opened this note, and the append is what creates it.
    await expect(append(jobId, transcript('Quarterly numbers look fine.'))).resolves.toMatchObject({
      appended: true,
    });

    const text = await searchText();
    expect(text).toContain('Transcript');
    expect(text).toContain('Planning call');
    expect(text).toContain('Quarterly numbers look fine.');

    const links = await withTenantScope(pool, scopeOf(tenant), (sql) =>
      sql.query<{ target_item_id: string }>(
        'SELECT target_item_id FROM item_link WHERE tenant_id = $1 AND source_item_id = $2',
        [tenant.tenantId, tenant.itemId],
      ),
    );
    expect(links.rows.map((row) => row.target_item_id)).toEqual([tenant.targetItemId]);
  });

  it('stores a long transcript as several updates that commit together', async () => {
    await noteWith(['Agenda.']);
    const splitting = createTranscriptionAppendService({ pool, core, batchBytes: 3_000 });
    const jobId = await leasedJob();
    const lines = Array.from({ length: 12 }, (_, index) => `Line ${String(index)}.`);

    await expect(
      splitting.append({ jobId, executionId: EXECUTION, body: transcript(...lines) }),
    ).resolves.toMatchObject({ appended: true, paragraphs: 12 });

    const stored = await storedLines();
    expect(stored).toHaveLength(1 + 2 + 12);
    expect(stored.slice(3).map((line) => line.replace(/^\[[\d:]+\] (Me|Others): /, ''))).toEqual(
      lines,
    );
    expect(await searchText()).toContain('Line 11.');

    const clients = await withTenantScope(pool, scopeOf(tenant), (sql) =>
      sql.query<{ client_id: string }>(
        `SELECT client_id FROM content_update
          WHERE tenant_id = $1 AND client_id LIKE 'transcription:%' ORDER BY seq`,
        [tenant.tenantId],
      ),
    );
    expect(clients.rows.map((row) => row.client_id)).toEqual([
      `transcription:${jobId}`,
      `transcription:${jobId}:2`,
      `transcription:${jobId}:3`,
      `transcription:${jobId}:4`,
    ]);

    // A numbered continuation is still this job's: the retry recognises it.
    await expect(
      splitting.append({ jobId, executionId: EXECUTION, body: transcript('Again.') }),
    ).resolves.toMatchObject({ appended: false });
  });

  it.each([
    ['another execution holds the lease', { owner: 'speech-worker:someone-else' }],
    ['the lease has expired', { leaseSeconds: -5 }],
    ['the job is of another kind', { kind: 'import.commit' }],
  ])('refuses and writes nothing when %s', async (_name, overrides) => {
    await noteWith(['Agenda.']);
    const jobId = await leasedJob(overrides);

    await expect(append(jobId, transcript('Should not land.'))).rejects.toMatchObject({
      status: 409,
      code: 'transcription_execution_lost',
    });
    expect(await storedLines()).toEqual(['Agenda.']);
  });

  it('refuses a job that does not exist', async () => {
    await expect(append(randomUUID(), transcript('Nothing.'))).rejects.toMatchObject({
      status: 409,
      code: 'transcription_execution_lost',
    });
    expect(await storedLines()).toEqual([]);
  });

  it('refuses a locked note and leaves it as it was', async () => {
    await noteWith(['Private.']);
    await lock(tenant.itemId);

    await expect(append(await leasedJob(), transcript('Should not land.'))).rejects.toMatchObject({
      status: 409,
      code: 'transcription_note_locked',
    });
    expect(await storedLines()).toEqual(['Private.']);
  });
});
