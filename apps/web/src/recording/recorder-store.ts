import { useSyncExternalStore } from 'react';

import { withWebmDuration } from '../lib/webm-duration';
import {
  CaptureError,
  formatForMimeType,
  openCapture,
  recordingFormat,
  type Capture,
  type CaptureFailure,
  type RecordingFormat,
  type RecordingSources,
} from './capture';
import { browserRecordingSpool, type SpooledSession } from './recording-spool';

/**
 * The one recorder the application has.
 *
 * **Why a module and not a component**, for the reason the audio player is one: a meeting is
 * recorded while the person reads, searches and takes notes elsewhere, so the recorder belongs to
 * the page and not to whichever screen started it. The bar in the shell is only a reader of this
 * state.
 *
 * **What it produces.** Stopping yields a finished recording held here until it has been saved or
 * discarded. Saving is not this module's work - it needs the workspace tree and the API client,
 * which the shell holds - but the recording stays in `finished`, and in the spool, until whoever
 * saves it says it is safe to forget.
 *
 * State is replaced, never mutated, so `useSyncExternalStore` can compare snapshots by identity.
 */

export interface FinishedRecording {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly blob: Blob;
  readonly format: RecordingFormat;
  /**
   * How a transcript can tell speakers apart: by channel when the recording began with shared
   * audio beside the microphone, and not at all otherwise.
   */
  readonly speakers: 'channels' | 'none';
  /** Found in the spool after a tab that was recording went away, rather than stopped here. */
  readonly recovered: boolean;
  /** Stopped by the recorder because the upload limit was near, not by the person. */
  readonly limitReached: boolean;
  /**
   * Ended without anybody asking: the microphone went away or the recorder failed. The meeting
   * may still be going on, so this is said loudly and not left to be noticed.
   */
  readonly unexpected: boolean;
  /**
   * Whether the slices also reached this device's storage. False in a private window or on a
   * full disk, where a closed tab would lose the recording, so the bar says so.
   */
  readonly spooled: boolean;
}

export type RecorderPhase = 'idle' | 'starting' | 'recording' | 'paused' | 'finishing';

export interface RecorderState {
  readonly phase: RecorderPhase;
  readonly sources: RecordingSources | null;
  /** The shared tab or screen stopped mid-recording; the microphone carried on alone. */
  readonly sharedEnded: boolean;
  /** Recorded time, pauses left out. */
  readonly elapsedMs: number;
  /** Why the last attempt to start was refused. */
  readonly failure: CaptureFailure | null;
  readonly finished: FinishedRecording | null;
}

const INITIAL: RecorderState = {
  phase: 'idle',
  sources: null,
  sharedEnded: false,
  elapsedMs: 0,
  failure: null,
  finished: null,
};

/** How often the recorder hands over a slice: what a crash can cost, at most. */
const SLICE_MS = 5000;
const TICK_MS = 500;
/** Uploads stop at 100 MiB; the recorder stops itself a little short of that. */
export const RECORDING_BYTE_LIMIT = 95 * 1024 * 1024;
/** The front of the file, where the header a recorder writes lives. */
const HEAD_BYTES = 4096;

let state: RecorderState = INITIAL;
const listeners = new Set<() => void>();

interface Session {
  readonly spooled: SpooledSession;
  readonly format: RecordingFormat;
  readonly capture: Capture;
  readonly recorder: MediaRecorder;
  readonly chunks: Blob[];
  bytes: number;
  /** Recorded time banked before the current stretch, and when that stretch began. */
  banked: number;
  resumedAt: number | null;
  limitReached: boolean;
  stopRequested: boolean;
  spoolFailed: boolean;
  timer: ReturnType<typeof setInterval> | null;
  wakeLock: WakeLockSentinel | null;
  resolveStop: ((recording: FinishedRecording | null) => void)[];
}

let session: Session | null = null;
/** Releases the lock that tells other tabs a spooled session is still in use here. */
let releaseSessionLock: (() => void) | null = null;

function update(patch: Partial<RecorderState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getRecorderState(): RecorderState {
  return state;
}

export function useRecorderState(): RecorderState {
  return useSyncExternalStore(subscribe, getRecorderState, getRecorderState);
}

function recorderIdle(): boolean {
  return state.phase === 'idle' && state.finished === null;
}

/**
 * Whether a new recording could start. For a reader that needs only that: the whole state is
 * replaced twice a second while the clock runs, and the shell must not re-render to its beat.
 */
export function useRecorderIdle(): boolean {
  return useSyncExternalStore(subscribe, recorderIdle, recorderIdle);
}

function lockName(sessionId: string): string {
  return `nix-recording:${sessionId}`;
}

function holdSessionLock(sessionId: string): void {
  releaseSessionLock?.();
  releaseSessionLock = null;
  if (typeof navigator === 'undefined' || !('locks' in navigator)) return;
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  void navigator.locks.request(lockName(sessionId), () => held).catch(() => undefined);
  releaseSessionLock = release;
}

function elapsed(current: Session): number {
  return current.banked + (current.resumedAt === null ? 0 : Date.now() - current.resumedAt);
}

function warnBeforeUnload(event: BeforeUnloadEvent): void {
  event.preventDefault();
}

function guardUnload(on: boolean): void {
  if (typeof window === 'undefined') return;
  if (on) window.addEventListener('beforeunload', warnBeforeUnload);
  else window.removeEventListener('beforeunload', warnBeforeUnload);
}

async function withDuration(
  blob: Blob,
  format: RecordingFormat,
  durationMs: number,
): Promise<Blob> {
  if (format.mediaType !== 'audio/webm') return blob;
  try {
    const head = new Uint8Array(await blob.slice(0, HEAD_BYTES).arrayBuffer());
    const patched = withWebmDuration(head, durationMs);
    if (patched === null) return blob;
    return new Blob([patched, blob.slice(head.length)], { type: format.mediaType });
  } catch {
    // An unreadable head leaves a file that plays without seeking, which beats no file.
    return blob;
  }
}

async function finish(current: Session): Promise<void> {
  if (session !== current) return;
  session = null;
  if (current.timer !== null) clearInterval(current.timer);
  const durationMs = elapsed(current);
  current.capture.close();
  void current.wakeLock?.release().catch(() => undefined);

  const raw = new Blob(current.chunks, { type: current.format.mediaType });
  const recording: FinishedRecording | null =
    raw.size === 0
      ? null
      : {
          sessionId: current.spooled.id,
          workspaceId: current.spooled.workspaceId,
          startedAt: current.spooled.startedAt,
          durationMs,
          blob: await withDuration(raw, current.format, durationMs),
          format: current.format,
          speakers: current.spooled.twoChannels ? 'channels' : 'none',
          recovered: false,
          limitReached: current.limitReached,
          unexpected: !current.stopRequested && !current.limitReached,
          spooled: !current.spoolFailed,
        };
  if (recording === null) {
    void browserRecordingSpool.discard(current.spooled.id).catch(() => undefined);
    releaseSessionLock?.();
    releaseSessionLock = null;
  }
  guardUnload(recording !== null);
  update({ phase: 'idle', sources: null, elapsedMs: durationMs, finished: recording });
  for (const resolve of current.resolveStop) resolve(recording);
}

/** Bumped by a cancel, so a start still waiting on a permission prompt knows it was called off. */
let startAttempt = 0;

/**
 * Calls off a start that is still waiting for the browser's prompts. Whatever the person then
 * answers in those prompts, nothing is recorded: they said no here first.
 */
export function cancelStartingRecording(): void {
  if (state.phase !== 'starting') return;
  startAttempt += 1;
  update({ phase: 'idle', failure: null });
}

export async function startRecording(options: {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly deviceId: string | null;
  readonly shareAudio: boolean;
}): Promise<boolean> {
  if (state.phase !== 'idle' || state.finished !== null) return false;
  const format = recordingFormat();
  if (format === null) {
    update({ failure: 'unsupported' });
    return false;
  }
  update({ phase: 'starting', failure: null, sharedEnded: false, elapsedMs: 0 });
  startAttempt += 1;
  const attempt = startAttempt;

  let capture: Capture;
  try {
    capture = await openCapture(options);
  } catch (error) {
    if (attempt === startAttempt) {
      update({ phase: 'idle', failure: error instanceof CaptureError ? error.reason : 'failed' });
    }
    return false;
  }
  if (attempt !== startAttempt) {
    capture.close();
    return false;
  }

  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(capture.stream, {
      mimeType: format.mimeType,
      audioBitsPerSecond: capture.sources === 'microphone' ? 32_000 : 48_000,
    });
  } catch {
    capture.close();
    update({ phase: 'idle', failure: 'failed' });
    return false;
  }

  const startedAt = Date.now();
  const current: Session = {
    spooled: {
      id: crypto.randomUUID(),
      workspaceId: options.workspaceId,
      principalId: options.principalId,
      startedAt,
      mimeType: format.mimeType,
      durationMs: 0,
      // Fixed at the start: the file is stereo from its first byte even if sharing stops later.
      twoChannels: capture.sources === 'microphone-and-shared',
    },
    format,
    capture,
    recorder,
    chunks: [],
    bytes: 0,
    banked: 0,
    resumedAt: startedAt,
    limitReached: false,
    stopRequested: false,
    spoolFailed: false,
    timer: null,
    wakeLock: null,
    resolveStop: [],
  };
  session = current;
  holdSessionLock(current.spooled.id);
  void browserRecordingSpool.begin(current.spooled).catch(() => {
    current.spoolFailed = true;
  });

  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size === 0) return;
    const index = current.chunks.length;
    current.chunks.push(event.data);
    current.bytes += event.data.size;
    void browserRecordingSpool
      .append({ ...current.spooled, durationMs: elapsed(current) }, index, event.data)
      .catch(() => {
        current.spoolFailed = true;
      });
    if (current.bytes >= RECORDING_BYTE_LIMIT && recorder.state !== 'inactive') {
      current.limitReached = true;
      recorder.stop();
    }
  });
  // Stopped by the person, by the limit, or by the browser when the microphone goes away: all
  // three end the same way, with whatever was recorded kept.
  recorder.addEventListener('stop', () => {
    void finish(current);
  });
  recorder.addEventListener('error', () => {
    if (recorder.state !== 'inactive') recorder.stop();
  });
  capture.onSharedEnded(() => {
    if (session === current) update({ sources: 'microphone', sharedEnded: true });
  });

  recorder.start(SLICE_MS);
  current.timer = setInterval(() => {
    if (session === current) update({ elapsedMs: elapsed(current) });
  }, TICK_MS);
  if (typeof navigator !== 'undefined' && 'wakeLock' in navigator) {
    void navigator.wakeLock
      .request('screen')
      .then((sentinel) => {
        if (session === current) current.wakeLock = sentinel;
        else void sentinel.release().catch(() => undefined);
      })
      .catch(() => undefined);
  }
  guardUnload(true);
  update({ phase: 'recording', sources: capture.sources });
  return true;
}

export function pauseRecording(): void {
  if (session === null || state.phase !== 'recording') return;
  session.banked = elapsed(session);
  session.resumedAt = null;
  session.recorder.pause();
  update({ phase: 'paused', elapsedMs: session.banked });
}

export function resumeRecording(): void {
  if (session === null || state.phase !== 'paused') return;
  session.resumedAt = Date.now();
  session.recorder.resume();
  update({ phase: 'recording' });
}

/** Stops and resolves with the recording, or null when nothing was captured. */
export function stopRecording(): Promise<FinishedRecording | null> {
  const current = session;
  if (current === null || (state.phase !== 'recording' && state.phase !== 'paused')) {
    return Promise.resolve(state.finished);
  }
  current.banked = elapsed(current);
  current.resumedAt = null;
  current.stopRequested = true;
  update({ phase: 'finishing', elapsedMs: current.banked });
  return new Promise((resolve) => {
    current.resolveStop.push(resolve);
    if (current.recorder.state !== 'inactive') current.recorder.stop();
    else void finish(current);
  });
}

/** Forgets the finished recording, here and in the spool: it was saved, or the person let it go. */
export function forgetFinishedRecording(): void {
  const finished = state.finished;
  if (finished === null) return;
  void browserRecordingSpool.discard(finished.sessionId).catch(() => undefined);
  releaseSessionLock?.();
  releaseSessionLock = null;
  guardUnload(false);
  update({ finished: null, elapsedMs: 0, sharedEnded: false });
}

/**
 * Takes a spooled session's lock if nobody holds it. One atomic question, so two tabs opening
 * together cannot both conclude the same session is theirs to offer and save.
 */
function claimSessionLock(sessionId: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('locks' in navigator)) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((done) => {
      release = done;
    });
    void navigator.locks
      .request(lockName(sessionId), { ifAvailable: true }, (lock) => {
        if (lock === null) {
          resolve(false);
          return undefined;
        }
        releaseSessionLock?.();
        releaseSessionLock = release;
        resolve(true);
        return held;
      })
      .catch(() => {
        resolve(false);
      });
  });
}

function releaseClaim(): void {
  releaseSessionLock?.();
  releaseSessionLock = null;
}

/**
 * Looks for a recording a vanished tab left in the spool and, if there is one, makes it the
 * finished recording so the bar can offer to save it.
 *
 * A session another tab is still recording looks the same in storage, so each live session holds
 * a lock and only a session whose lock can be taken is offered. Where the browser has no locks,
 * nothing is offered: showing somebody their own live recording as "interrupted" would be worse.
 * Only the person who made a recording is ever offered it back.
 */
export async function recoverInterruptedRecording(
  workspaceId: string,
  principalId: string,
): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  let sessions: SpooledSession[];
  try {
    sessions = await browserRecordingSpool.sessions(workspaceId, principalId);
  } catch {
    return;
  }
  for (const spooled of sessions) {
    if (!recorderIdle()) return;
    if (!(await claimSessionLock(spooled.id))) continue;
    const format = formatForMimeType(spooled.mimeType);
    const chunks = await browserRecordingSpool.read(spooled.id).catch(() => []);
    const raw = new Blob(chunks, { type: format?.mediaType ?? '' });
    if (format === null || raw.size === 0) {
      void browserRecordingSpool.discard(spooled.id).catch(() => undefined);
      releaseClaim();
      continue;
    }
    const blob = await withDuration(raw, format, spooled.durationMs);
    // Checked after the reads, which take time: a recording may have started meanwhile, and it
    // has taken the lock slot for itself.
    if (!recorderIdle()) return;
    guardUnload(true);
    update({
      finished: {
        sessionId: spooled.id,
        workspaceId: spooled.workspaceId,
        startedAt: spooled.startedAt,
        durationMs: spooled.durationMs,
        blob,
        format,
        speakers: spooled.twoChannels ? 'channels' : 'none',
        recovered: true,
        limitReached: false,
        unexpected: false,
        spooled: true,
      },
    });
    return;
  }
}

export function clearRecorderFailure(): void {
  if (state.failure !== null) update({ failure: null });
}

/**
 * Drops whatever is being recorded or waiting to be saved, without keeping any of it. For signing
 * out: audio captured under one account must not be on offer to the next person at this device.
 */
export function abandonRecording(): void {
  const current = session;
  session = null;
  if (current !== null) {
    if (current.timer !== null) clearInterval(current.timer);
    if (current.recorder.state !== 'inactive') current.recorder.stop();
    current.capture.close();
    void current.wakeLock?.release().catch(() => undefined);
    for (const resolve of current.resolveStop) resolve(null);
  }
  releaseSessionLock?.();
  releaseSessionLock = null;
  guardUnload(false);
  state = INITIAL;
  for (const listener of listeners) listener();
}
