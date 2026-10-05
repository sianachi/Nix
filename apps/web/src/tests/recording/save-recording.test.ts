import type * as ApiClient from '@nix/api-client';
import type { NixClient } from '@nix/api-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FinishedRecording } from '../../recording/recorder-store';
import {
  recordingFileName,
  saveFailureMessage,
  saveRecording,
} from '../../recording/save-recording';

const WORKSPACE = '00000000-0000-4000-8000-000000000001';
const NOTE = 'a1000000-0000-4000-8000-000000000001';
const AUDIO = 'b1000000-0000-4000-8000-000000000001';

const api = vi.hoisted(() => ({
  beginUpload: vi.fn((input: unknown) => ({ operation: 'files.beginUpload', input })),
  uploadAndCompleteFile: vi.fn(),
}));

vi.mock('@nix/api-client', async (original) => {
  const actual = await original<typeof ApiClient>();
  return {
    ...actual,
    files: {
      ...actual.files,
      beginUpload: api.beginUpload,
      uploadAndCompleteFile: api.uploadAndCompleteFile,
    },
  };
});

const upload = { id: 'upload' };
const client = { execute: vi.fn(() => Promise.resolve(upload)) } as unknown as NixClient;

const recording: FinishedRecording = {
  sessionId: 'session',
  workspaceId: WORKSPACE,
  startedAt: new Date(2026, 9, 5, 14, 30).getTime(),
  durationMs: 60_000,
  blob: new Blob([new Uint8Array(128)], { type: 'audio/webm' }),
  format: { mimeType: 'audio/webm;codecs=opus', mediaType: 'audio/webm', extension: 'weba' },
  speakers: 'channels',
  recovered: false,
  limitReached: false,
  unexpected: false,
  spooled: true,
};

beforeEach(() => {
  api.beginUpload.mockClear();
  api.uploadAndCompleteFile.mockReset().mockResolvedValue({ itemId: AUDIO });
});

describe('saving a recording', () => {
  it('makes the meeting note, then uploads the audio beneath it', async () => {
    const createNote = vi.fn(() => Promise.resolve({ id: NOTE, refusal: null }));
    const onNoteCreated = vi.fn();

    const saved = await saveRecording(client, recording, {
      noteId: null,
      createNote,
      onNoteCreated,
    });

    expect(saved).toEqual({ noteId: NOTE, audioItemId: AUDIO });
    expect(createNote).toHaveBeenCalledWith(expect.stringMatching(/^Meeting, /));
    expect(onNoteCreated).toHaveBeenCalledWith(NOTE);
    expect(api.beginUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE,
        parentId: NOTE,
        fileName: 'Meeting 2026-10-05 14.30.weba',
        // Bare: Core refuses a type that carries its codec.
        mediaType: 'audio/webm',
        byteLength: 128,
      }),
    );
    expect(api.uploadAndCompleteFile).toHaveBeenCalledWith(
      client,
      upload,
      recording.blob,
      undefined,
    );
  });

  it('uploads under the note an earlier attempt made instead of making another', async () => {
    const createNote = vi.fn(() => Promise.resolve({ id: 'never', refusal: null }));
    api.uploadAndCompleteFile.mockRejectedValueOnce(new Error('The file upload failed (503).'));
    const onNoteCreated = vi.fn();

    await expect(
      saveRecording(client, recording, { noteId: null, createNote, onNoteCreated }),
    ).rejects.toThrow('The file upload failed (503).');
    // The note exists by now, and the caller has been told so before the upload failed.
    expect(onNoteCreated).toHaveBeenCalledOnce();

    createNote.mockClear();
    await saveRecording(client, recording, { noteId: NOTE, createNote, onNoteCreated });

    expect(createNote).not.toHaveBeenCalled();
    const keys = api.beginUpload.mock.calls.map(
      ([input]) => (input as { idempotencyKey: string }).idempotencyKey,
    );
    expect(new Set(keys).size).toBe(2);
  });

  it('reports the refusal when the note cannot be created', async () => {
    await expect(
      saveRecording(client, recording, {
        noteId: null,
        createNote: () => Promise.resolve({ id: null, refusal: 'This workspace is read-only.' }),
        onNoteCreated: vi.fn(),
      }),
    ).rejects.toThrow('This workspace is read-only.');
    expect(api.beginUpload).not.toHaveBeenCalled();
  });

  it('explains a failure without the transport’s status code', async () => {
    api.uploadAndCompleteFile.mockRejectedValueOnce(new Error('The file upload failed (503).'));
    const failure = await saveRecording(client, recording, {
      noteId: NOTE,
      createNote: vi.fn(),
      onNoteCreated: vi.fn(),
    }).catch((error: unknown) => error);

    expect(saveFailureMessage(failure)).toBe('The recording could not be uploaded.');

    const refused = await saveRecording(client, recording, {
      noteId: null,
      createNote: () => Promise.resolve({ id: null, refusal: 'This workspace is read-only.' }),
      onNoteCreated: vi.fn(),
    }).catch((error: unknown) => error);
    expect(saveFailureMessage(refused)).toBe('This workspace is read-only.');
  });

  it('names the file the same way in every locale', () => {
    expect(recordingFileName(new Date(2026, 0, 3, 9, 5).getTime(), 'm4a')).toBe(
      'Meeting 2026-01-03 09.05.m4a',
    );
  });
});
