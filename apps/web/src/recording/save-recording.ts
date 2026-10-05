import { files, isNixApiError, type NixClient } from '@nix/api-client';

import type { FinishedRecording } from './recorder-store';

/**
 * Turns a finished recording into what it is in Nix: a note for the meeting, with the audio as a
 * file beneath it.
 *
 * Two steps that can fail separately, so the note's id is handed back the moment it exists. A
 * retry after a failed upload passes it in again and uploads under the same note rather than
 * leaving an empty "Meeting" behind for every attempt.
 */

export interface SaveTarget {
  /** The note made by an earlier attempt, or null when there has been none. */
  readonly noteId: string | null;
  readonly createNote: (title: string) => Promise<{ id: string | null; refusal: string | null }>;
  /** Told as soon as the note exists, before the upload that may still fail. */
  readonly onNoteCreated: (noteId: string) => void;
}

export interface SavedRecording {
  readonly noteId: string;
  readonly audioItemId: string;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function recordingTitle(startedAt: number): string {
  const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return `Meeting, ${when.format(new Date(startedAt))}`;
}

/** A name that is the same in every locale and safe on every file system. */
export function recordingFileName(startedAt: number, extension: string): string {
  const at = new Date(startedAt);
  const date = `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  return `Meeting ${date} ${pad(at.getHours())}.${pad(at.getMinutes())}.${extension}`;
}

/** The note for a recording could not be made; `message` is Core's own reason. */
export class NoteRefusedError extends Error {
  override readonly name = 'NoteRefusedError';
}

/**
 * Why a save failed, in words. Core's own reason where it gave one; otherwise that the upload
 * failed, without the transport's status code, which tells the person nothing they can act on.
 */
export function saveFailureMessage(error: unknown): string {
  if (error instanceof NoteRefusedError && error.message !== '') return error.message;
  if (isNixApiError(error) && error.detail !== undefined) return error.detail;
  return 'The recording could not be uploaded.';
}

export async function saveRecording(
  client: NixClient,
  recording: FinishedRecording,
  target: SaveTarget,
  signal?: AbortSignal,
): Promise<SavedRecording> {
  let noteId = target.noteId;
  if (noteId === null) {
    const created = await target.createNote(recordingTitle(recording.startedAt));
    if (created.id === null) {
      throw new NoteRefusedError(
        created.refusal ?? 'The note for this recording could not be created.',
      );
    }
    noteId = created.id;
    target.onNoteCreated(noteId);
  }

  const upload = await client.execute(
    files.beginUpload({
      workspaceId: recording.workspaceId,
      parentId: noteId,
      fileName: recordingFileName(recording.startedAt, recording.format.extension),
      mediaType: recording.format.mediaType,
      byteLength: recording.blob.size,
      // A fresh key each attempt: a failed upload is cancelled, and its key would hand the
      // cancelled upload back.
      idempotencyKey: `web-recording:${recording.sessionId}:${crypto.randomUUID()}`,
    }),
    { signal },
  );
  const audio = await files.uploadAndCompleteFile(client, upload, recording.blob, signal);
  return { noteId, audioItemId: audio.itemId };
}
