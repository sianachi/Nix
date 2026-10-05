import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Capture from '../../recording/capture';
import type * as RecorderStore from '../../recording/recorder-store';
import type * as Spool from '../../recording/recording-spool';
import { FakeMediaRecorder, fakeLocks, lastRecorder } from './fake-recorder';

const WORKSPACE = '00000000-0000-4000-8000-000000000001';
const OWNER = 'tenant:ada';
const WEBM = { mimeType: 'audio/webm;codecs=opus', mediaType: 'audio/webm', extension: 'weba' };

const capture = vi.hoisted(() => ({
  openCapture: vi.fn(),
  close: vi.fn(),
  sharedEnded: [] as (() => void)[],
}));

vi.mock('../../recording/capture', async (original) => ({
  ...(await original<typeof Capture>()),
  recordingFormat: () => WEBM,
  openCapture: capture.openCapture,
}));

let store: typeof RecorderStore;
let spool: typeof Spool;
let locks: ReturnType<typeof fakeLocks>;

function slice(bytes: number): Blob {
  return new Blob([new Uint8Array(bytes)]);
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-10-05T14:30:00Z'));
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  locks = fakeLocks();
  vi.stubGlobal('navigator', { locks: locks.locks });
  FakeMediaRecorder.instances = [];
  capture.sharedEnded = [];
  capture.close.mockReset();
  capture.openCapture.mockReset().mockImplementation(() =>
    Promise.resolve({
      stream: {} as MediaStream,
      sources: 'microphone-and-shared',
      onSharedEnded: (listener: () => void) => capture.sharedEnded.push(listener),
      close: capture.close,
    }),
  );
  store = await import('../../recording/recorder-store');
  spool = await import('../../recording/recording-spool');
});

afterEach(() => {
  store.abandonRecording();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function start(): Promise<void> {
  expect(
    await store.startRecording({
      workspaceId: WORKSPACE,
      principalId: OWNER,
      deviceId: null,
      shareAudio: true,
    }),
  ).toBe(true);
}

describe('recording a meeting', () => {
  it('records in stereo slices and hands back one file when stopped', async () => {
    await start();
    expect(store.getRecorderState()).toMatchObject({
      phase: 'recording',
      sources: 'microphone-and-shared',
    });
    expect(lastRecorder().options).toMatchObject({
      mimeType: WEBM.mimeType,
      audioBitsPerSecond: 48_000,
    });

    lastRecorder().emit(slice(300));
    vi.advanceTimersByTime(5_000);
    lastRecorder().emit(slice(200));
    const recording = await store.stopRecording();

    expect(recording).toMatchObject({
      workspaceId: WORKSPACE,
      durationMs: 5_000,
      format: WEBM,
      speakers: 'channels',
      recovered: false,
      limitReached: false,
    });
    expect(recording?.blob.size).toBe(500);
    expect(recording?.blob.type).toBe('audio/webm');
    expect(capture.close).toHaveBeenCalledOnce();
    expect(store.getRecorderState()).toMatchObject({ phase: 'idle', finished: recording });
  });

  it('leaves paused time out of the length', async () => {
    await start();
    vi.advanceTimersByTime(4_000);
    store.pauseRecording();
    expect(lastRecorder().state).toBe('paused');
    vi.advanceTimersByTime(60_000);
    store.resumeRecording();
    vi.advanceTimersByTime(1_000);
    lastRecorder().emit(slice(10));

    expect((await store.stopRecording())?.durationMs).toBe(5_000);
  });

  it('says why it could not start and stays ready to try again', async () => {
    const { CaptureError } = await import('../../recording/capture');
    capture.openCapture.mockRejectedValueOnce(new CaptureError('microphone-denied'));

    expect(
      await store.startRecording({
        workspaceId: WORKSPACE,
        principalId: OWNER,
        deviceId: null,
        shareAudio: false,
      }),
    ).toBe(false);

    expect(store.getRecorderState()).toMatchObject({ phase: 'idle', failure: 'microphone-denied' });
    await start();
    expect(store.getRecorderState().failure).toBeNull();
  });

  it('carries on with the microphone when sharing stops', async () => {
    await start();

    capture.sharedEnded[0]?.();

    expect(store.getRecorderState()).toMatchObject({
      phase: 'recording',
      sources: 'microphone',
      sharedEnded: true,
    });
    // The file was stereo from its first byte, so it is still transcribed by channel.
    lastRecorder().emit(slice(10));
    expect((await store.stopRecording())?.speakers).toBe('channels');
  });

  it('does not claim speakers for a microphone-only recording', async () => {
    capture.openCapture.mockImplementationOnce(() =>
      Promise.resolve({
        stream: {} as MediaStream,
        sources: 'microphone',
        onSharedEnded: () => undefined,
        close: capture.close,
      }),
    );
    await start();
    lastRecorder().emit(slice(10));

    expect((await store.stopRecording())?.speakers).toBe('none');
    expect(lastRecorder().options).toMatchObject({ audioBitsPerSecond: 32_000 });
  });

  it('stops itself short of the upload limit and keeps what it has', async () => {
    await start();
    const huge = slice(4);
    Object.defineProperty(huge, 'size', { value: store.RECORDING_BYTE_LIMIT });

    lastRecorder().emit(huge);

    expect(lastRecorder().state).toBe('inactive');
    await vi.waitFor(() => {
      expect(store.getRecorderState().finished).toMatchObject({ limitReached: true });
    });
  });

  it('keeps nothing when nothing was captured', async () => {
    await start();

    expect(await store.stopRecording()).toBeNull();

    expect(store.getRecorderState()).toMatchObject({ phase: 'idle', finished: null });
    await vi.waitFor(async () => {
      expect(await spool.browserRecordingSpool.sessions(WORKSPACE, OWNER)).toEqual([]);
    });
  });

  it('records nothing when the start is called off while the browser is still asking', async () => {
    let allow: (capture: unknown) => void = () => undefined;
    capture.openCapture.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          allow = resolve;
        }),
    );
    const starting = store.startRecording({
      workspaceId: WORKSPACE,
      principalId: OWNER,
      deviceId: null,
      shareAudio: false,
    });
    expect(store.getRecorderState().phase).toBe('starting');

    store.cancelStartingRecording();
    // The person then allows the microphone in the browser's own prompt.
    allow({
      stream: {} as MediaStream,
      sources: 'microphone',
      onSharedEnded: () => undefined,
      close: capture.close,
    });

    expect(await starting).toBe(false);
    expect(store.getRecorderState().phase).toBe('idle');
    expect(capture.close).toHaveBeenCalledOnce();
    expect(FakeMediaRecorder.instances).toHaveLength(0);
  });

  it('says when a recording ended without anybody stopping it', async () => {
    await start();
    lastRecorder().emit(slice(10));

    // The browser ends the recorder by itself: the microphone was unplugged.
    lastRecorder().stop();

    await vi.waitFor(() => {
      expect(store.getRecorderState().finished).toMatchObject({
        unexpected: true,
        limitReached: false,
      });
    });
  });

  it('does not call a stop the person asked for unexpected', async () => {
    await start();
    lastRecorder().emit(slice(10));

    expect(await store.stopRecording()).toMatchObject({ unexpected: false, spooled: true });
  });

  it('refuses a second recording while one is waiting to be saved', async () => {
    await start();
    lastRecorder().emit(slice(10));
    await store.stopRecording();

    expect(
      await store.startRecording({
        workspaceId: WORKSPACE,
        principalId: OWNER,
        deviceId: null,
        shareAudio: false,
      }),
    ).toBe(false);
  });
});

describe('a recording that outlives its tab', () => {
  it('spools each slice and forgets them once the recording is let go', async () => {
    await start();
    lastRecorder().emit(slice(300));
    lastRecorder().emit(slice(200));

    const [session] = await spool.browserRecordingSpool.sessions(WORKSPACE, OWNER);
    expect(session).toMatchObject({ workspaceId: WORKSPACE, mimeType: WEBM.mimeType });
    await vi.waitFor(async () => {
      const spooled = await spool.browserRecordingSpool.read(session?.id ?? '');
      expect(spooled.map((chunk) => chunk.size)).toEqual([300, 200]);
    });

    await store.stopRecording();
    store.forgetFinishedRecording();

    expect(store.getRecorderState().finished).toBeNull();
    await vi.waitFor(async () => {
      expect(await spool.browserRecordingSpool.sessions(WORKSPACE, OWNER)).toEqual([]);
    });
  });

  it('offers back a recording whose tab went away', async () => {
    const orphan = {
      id: 'orphan',
      workspaceId: WORKSPACE,
      principalId: OWNER,
      startedAt: Date.now() - 3_600_000,
      mimeType: WEBM.mimeType,
      durationMs: 42_000,
      twoChannels: true,
    };
    await spool.browserRecordingSpool.begin(orphan);
    await spool.browserRecordingSpool.append(orphan, 0, slice(64));

    await store.recoverInterruptedRecording(WORKSPACE, OWNER);

    expect(store.getRecorderState().finished).toMatchObject({
      sessionId: 'orphan',
      durationMs: 42_000,
      recovered: true,
      // Kept with the spooled session, so a recovered meeting is still transcribed by speaker.
      speakers: 'channels',
    });
    expect(store.getRecorderState().finished?.blob.size).toBe(64);
  });

  it('does not offer a recording another tab is still making', async () => {
    const live = {
      id: 'live',
      workspaceId: WORKSPACE,
      principalId: OWNER,
      startedAt: Date.now(),
      mimeType: WEBM.mimeType,
      durationMs: 5_000,
      twoChannels: false,
    };
    await spool.browserRecordingSpool.begin(live);
    await spool.browserRecordingSpool.append(live, 0, slice(64));
    locks.held.add('nix-recording:live');

    await store.recoverInterruptedRecording(WORKSPACE, OWNER);

    expect(store.getRecorderState().finished).toBeNull();
    expect(await spool.browserRecordingSpool.sessions(WORKSPACE, OWNER)).toHaveLength(1);
  });

  it('never offers one person’s recording to another', async () => {
    const theirs = {
      id: 'theirs',
      workspaceId: WORKSPACE,
      principalId: 'tenant:grace',
      startedAt: Date.now() - 3_600_000,
      mimeType: WEBM.mimeType,
      durationMs: 42_000,
      twoChannels: false,
    };
    await spool.browserRecordingSpool.begin(theirs);
    await spool.browserRecordingSpool.append(theirs, 0, slice(64));

    await store.recoverInterruptedRecording(WORKSPACE, OWNER);

    expect(store.getRecorderState().finished).toBeNull();
  });

  it('drops everything when the person signs out', async () => {
    await start();
    lastRecorder().emit(slice(10));

    store.abandonRecording();
    await spool.clearRecordingSpool();

    expect(store.getRecorderState()).toMatchObject({ phase: 'idle', finished: null });
    expect(capture.close).toHaveBeenCalled();
    expect(await spool.browserRecordingSpool.sessions(WORKSPACE, OWNER)).toEqual([]);
  });
});
