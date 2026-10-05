import { randomUUID } from 'node:crypto';

import { SHEET_CELLS_KEY, SHEET_META_KEY } from '@nix/sheet';
import type { Pool } from 'pg';
import type * as Y from 'yjs';

import { findDocByItem, hasUpdateFromClient } from '../db/documents.ts';
import { lockedAmong } from '../db/locks.ts';
import { withTenantScope } from '../db/tenant-scope.ts';
import { workerExecutionHeld } from '../db/worker-executions.ts';
import { CANVAS_ELEMENTS, FRAGMENT_NAME, noteStrategy } from '../documents/body-kinds.ts';
import { LIMITS, type Rejection } from '../documents/limits.ts';
import { applyUpdate, loadDocument, openDocument } from '../documents/service.ts';
import type { CoreTranscriptionClient } from './core.ts';
import {
  writeTranscriptSection,
  type TranscriptParagraph,
  type TranscriptSource,
  type TranscriptSpeaker,
} from './section.ts';

export interface TranscriptionAppendResult {
  /** False when this job had already appended: a retry of a call that succeeded. */
  readonly appended: boolean;
  readonly paragraphs: number;

  /** The note Core named, so the caller can bring an open copy of it up to date. */
  readonly noteItemId: string;
}

export interface TranscriptionAppendService {
  append(input: {
    readonly jobId: string;
    readonly executionId: string;
    readonly body: unknown;
  }): Promise<TranscriptionAppendResult>;
}

export class TranscriptionAppendError extends Error {
  public readonly status: number;
  public readonly code: string;

  public constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'TranscriptionAppendError';
    this.status = status;
    this.code = code;
  }
}

/** The request's own ceilings. A long meeting is a few thousand paragraphs; nothing is this long. */
const MAX_PARAGRAPHS = 5_000;
const MAX_PARAGRAPH_CHARACTERS = 4_000;

/**
 * How much transcript one update carries before the next is started: half the update ceiling,
 * because the plan is made from an estimate and the ceiling is a refusal.
 */
const DEFAULT_BATCH_BYTES = LIMITS.updateBytes / 2;

interface ParsedRequest {
  readonly durationMillis: number;
  readonly paragraphs: readonly TranscriptParagraph[];
}

/**
 * Appends a meeting transcript to the end of an existing note, as a merge.
 *
 * **Called by the speech worker, on behalf of the person who asked for the transcription.** The
 * worker holds no user token, so the call is authorized by what it does hold - the service
 * secret and a live lease on a `transcribe.audio` job - and Core turns that into the note, the
 * recording and the principal. Nothing in the request names a note: a worker that could would be
 * a worker that can write to any note in the tenant.
 *
 * **One transaction, in an order that matters:**
 *
 * 1. the fence, which locks the job row, so the lease cannot move to another execution while
 *    this one is still writing;
 * 2. the idempotency check, so a retry of a call whose response was lost changes nothing - and
 *    says so even when the note has been locked since, because the truthful answer to "did my
 *    append land" does not depend on what happened to the note afterwards;
 * 3. the lock check, on the note *and* the recording: a locked note's body is not this service's
 *    to change, and a locked recording's words are not this service's to copy somewhere unlocked;
 * 4. the edit, applied through the same `applyUpdate` every REST write takes - validated against
 *    the merged document, logged, snapshotted, published to search and backlinks.
 *
 * **It is a merge, not a write.** The edit is a Yjs update that deletes this service's own
 * earlier section, if there is one, and inserts the new one. Whatever anybody else typed while
 * the recording was being transcribed - before the section, after it, in another tab right now -
 * is left exactly as it was.
 *
 * The transcript itself is never logged, here or by the route: it is the content of a meeting.
 */
export function createTranscriptionAppendService(input: {
  readonly pool: Pool;
  readonly core: CoreTranscriptionClient;
  readonly newDocId?: (() => string) | undefined;

  /** The planning budget for one update. Lowered by tests to exercise the split. */
  readonly batchBytes?: number | undefined;
}): TranscriptionAppendService {
  const newDocId = input.newDocId ?? randomUUID;
  const batchBytes = input.batchBytes ?? DEFAULT_BATCH_BYTES;

  return {
    async append(request) {
      // Refused before Core is asked anything: a malformed transcript is the worker's fault
      // whatever the job is, and this is the one refusal that needs no round trip.
      const parsed = parseRequest(request.body);
      if (!UUID.test(request.jobId)) {
        // The fence casts this to a uuid; a value that is not one would be a database error
        // where "no such job" is meant.
        throw notFound();
      }

      const authorization = await input.core.authorize({
        jobId: request.jobId,
        executionId: request.executionId,
      });
      const { tenantId, principalId, workspaceId, noteItemId } = authorization;
      const source: TranscriptSource = {
        workspaceId,
        audioItemId: authorization.audioItemId,
        audioTitle: authorization.audioTitle,
        durationMillis: parsed.durationMillis,
      };
      // The log row this write leaves is also the record that the job landed, which is why the
      // client id is derived from the job rather than minted.
      const clientId = `transcription:${request.jobId}`;

      const appended = await withTenantScope(input.pool, { tenantId, principalId }, async (sql) => {
        const held = await workerExecutionHeld(
          sql,
          { tenantId, workspaceId, principalId },
          { jobId: request.jobId, executionId: request.executionId, kind: 'transcribe.audio' },
        );
        if (!held) {
          throw new TranscriptionAppendError(
            409,
            'transcription_execution_lost',
            'The transcription worker no longer owns this job lease.',
          );
        }

        const existing = await findDocByItem(sql, tenantId, noteItemId);
        if (existing !== null && existing.workspace_id !== workspaceId) {
          throw notFound();
        }
        if (
          existing !== null &&
          (await hasUpdateFromClient(sql, tenantId, existing.doc_id, clientId))
        ) {
          return false;
        }

        // Core authorized the job when it was made; either item may have been locked, or moved
        // under a locked folder, in the minutes a long recording takes to transcribe. Asked in
        // the transaction that writes, so the answer and the write see the same state. The
        // recording counts as much as the note: its transcript is its content, and writing that
        // into an unlocked note would carry it out from behind the lock. One refusal for both,
        // because the worker's reaction is the same - stop, this needs a person.
        const locked = await lockedAmong(sql, tenantId, [noteItemId, authorization.audioItemId]);
        if (locked.size > 0) {
          throw new TranscriptionAppendError(
            409,
            'transcription_note_locked',
            locked.has(noteItemId)
              ? "The note's body is locked. Unlock it and transcribe again."
              : 'The recording is locked. Unlock it and transcribe again.',
          );
        }

        // A note nobody has opened has no body yet; it gets one, and the section is all it holds.
        const doc =
          existing ?? (await openDocument(sql, tenantId, noteItemId, workspaceId, newDocId));
        if (doc === null) {
          throw notFound();
        }

        const live = await loadDocument(sql, tenantId, doc);
        try {
          if (holdsAnotherBodyKind(live)) {
            throw unsupported();
          }

          let current = doc;
          let step = 0;
          const updates = writeTranscriptSection(
            live,
            FRAGMENT_NAME,
            source,
            parsed.paragraphs,
            batchBytes,
          );
          let next = updates.next();
          while (next.done !== true) {
            const update = next.value;
            next = updates.next();
            step += 1;

            const applied = await applyUpdate(sql, {
              tenantId,
              doc: current,
              updateBytes: update,
              actorId: principalId,
              clientId: step === 1 ? clientId : `${clientId}:${String(step)}`,
              // Publish on the last step, like every other REST write: with no editor open,
              // nothing else would carry the transcript to search and backlinks. Not on the
              // earlier steps - each snapshot materialises the whole document, and nobody can
              // observe a state this transaction has not committed.
              snapshotEvery: next.done === true ? 1 : 0,
              strategy: noteStrategy,
            });
            if (!applied.ok) {
              // Thrown, not returned: the steps before this one are already in the log inside
              // this transaction, and a transcript missing its second half must not commit.
              throw refusalFor(applied.error);
            }
            current = { ...current, head_seq: applied.value.seq.toString() };
          }
        } finally {
          live.destroy();
        }
        return true;
      });

      return { appended, paragraphs: parsed.paragraphs.length, noteItemId };
    },
  };
}

/**
 * Whether this document is a canvas or a sheet rather than prose.
 *
 * Core's answer does not say what kind of body the note has, and this service's role cannot read
 * `item.type`, so the document is asked: a canvas keeps its scene and a sheet its cells in maps a
 * prose note never has. A prose section written into either would be stored, never drawn, and
 * reported to the worker as a success.
 *
 * It cannot see a canvas or sheet that has never been written to - that document is empty, like
 * a new note's. That case never reaches here: Core knows the item's type and refuses to create a
 * transcription whose target is anything but exactly a `note`. This is the second line, for a
 * body that says otherwise.
 */
function holdsAnotherBodyKind(state: Y.Doc): boolean {
  return [CANVAS_ELEMENTS, SHEET_CELLS_KEY, SHEET_META_KEY].some(
    (name) => state.getMap(name).size > 0,
  );
}

function refusalFor(rejection: Rejection): TranscriptionAppendError {
  if (
    rejection.code === 'update_too_large' ||
    rejection.code === 'document_too_many_nodes' ||
    rejection.code === 'document_too_large'
  ) {
    return new TranscriptionAppendError(
      413,
      'transcription_too_large',
      'The note would be too large with this transcript appended.',
    );
  }
  // What is left is a body this build cannot write the section into: one that does not parse as
  // prose, or one pinned to a schema version older than the reference node the section carries.
  // The rejection's own detail goes with it - it names the pin and the migration to run, and
  // describes the document, never its text.
  return new TranscriptionAppendError(409, 'transcription_note_unsupported', rejection.detail);
}

function unsupported(): TranscriptionAppendError {
  return new TranscriptionAppendError(
    409,
    'transcription_note_unsupported',
    'A transcript can only be appended to a note with a prose body.',
  );
}

function notFound(): TranscriptionAppendError {
  return new TranscriptionAppendError(
    404,
    'transcription_not_found',
    'No such transcription is available.',
  );
}

function invalid(message: string): TranscriptionAppendError {
  return new TranscriptionAppendError(400, 'transcription_invalid', message);
}

function parseRequest(value: unknown): ParsedRequest {
  if (!record(value)) {
    throw invalid('Expected a transcript object.');
  }
  if (!millis(value.durationMillis)) {
    throw invalid('durationMillis must be a non-negative integer.');
  }
  if (!Array.isArray(value.paragraphs) || value.paragraphs.length > MAX_PARAGRAPHS) {
    throw invalid(`paragraphs must be an array of at most ${String(MAX_PARAGRAPHS)} entries.`);
  }
  const paragraphs = value.paragraphs.map((candidate: unknown): TranscriptParagraph => {
    if (
      !record(candidate) ||
      !millis(candidate.startMillis) ||
      !speaker(candidate.speaker) ||
      typeof candidate.text !== 'string' ||
      candidate.text.length === 0 ||
      // Postgres stores neither text nor jsonb containing NUL, so the snapshot of a note holding
      // one would fail after the update was accepted.
      candidate.text.includes('\u0000') ||
      !withinCharacters(candidate.text, MAX_PARAGRAPH_CHARACTERS)
    ) {
      // Says which rule, never which paragraph's text: the refusal ends up in a worker's log.
      throw invalid(
        'Each paragraph needs a non-negative integer startMillis, a speaker of "", "me" or ' +
          `"others", and 1 to ${String(MAX_PARAGRAPH_CHARACTERS)} characters of text without NUL.`,
      );
    }
    return {
      startMillis: candidate.startMillis,
      speaker: candidate.speaker,
      text: candidate.text,
    };
  });
  return { durationMillis: value.durationMillis, paragraphs };
}

function millis(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function speaker(value: unknown): value is TranscriptSpeaker {
  return value === '' || value === 'me' || value === 'others';
}

/**
 * Whether a string is at most `limit` characters, counted as code points.
 *
 * The worker is written in Go and counts runes; `length` here counts UTF-16 units and would
 * refuse a paragraph of emoji or rarer scripts the worker had measured as fitting. The cheap
 * comparison answers almost every call, since units are never fewer than code points.
 */
function withinCharacters(value: string, limit: number): boolean {
  if (value.length <= limit) {
    return true;
  }
  // Each surrogate pair is two units and one code point.
  const pairs = value.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)?.length ?? 0;
  return value.length - pairs <= limit;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
