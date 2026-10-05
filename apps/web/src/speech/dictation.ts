import type { NixClient } from '@nix/api-client';
import { useSyncExternalStore } from 'react';

import { speechVocabularyHint } from '../lib/speech-vocabulary';
import { recordingFormat } from '../recording/capture';
import { readPreferredMicrophone } from '../recording/recording-preferences';
import { SpeechError, dictate } from './speech-client';

/**
 * Dictation through Nix's own recogniser: record a short clip, send it, get the words back.
 *
 * Press to start, press again to finish. It is not word-by-word: the clip is recognised whole,
 * which is what makes the punctuation and the names come out right, and the answer arrives a
 * moment after the second press. One dictation at a time for the whole page, owned by whichever
 * surface started it, so the pet's microphone button and the editor's can never both be live.
 * The clip goes to the speech worker and nowhere else, and is kept by neither side.
 */

/** A clip is cut off here, which leaves room under the ninety seconds the speech worker allows. */
export const DICTATION_LIMIT_MS = 60_000;

export interface DictationState {
  readonly status: 'idle' | 'starting' | 'recording' | 'transcribing';
  readonly owner: string | null;
  readonly error: string | null;
}

const IDLE: DictationState = { status: 'idle', owner: null, error: null };

let state: DictationState = IDLE;
const listeners = new Set<() => void>();
let generation = 0;

interface Live {
  readonly recorder: MediaRecorder;
  readonly stream: MediaStream;
  readonly chunks: Blob[];
  readonly limit: ReturnType<typeof setTimeout>;
  readonly client: NixClient;
  readonly onText: (text: string) => void;
  readonly mediaType: string;
}
let live: Live | null = null;
let abort: AbortController | null = null;

function update(next: DictationState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getDictationState(): DictationState {
  return state;
}

export function useDictationState(): DictationState {
  return useSyncExternalStore(subscribe, getDictationState, getDictationState);
}

/** Whether this browser can record a clip to send at all. */
export function canRecordDictation(): boolean {
  return recordingFormat() !== null;
}

function closeLive(): void {
  if (live === null) return;
  clearTimeout(live.limit);
  for (const track of live.stream.getTracks()) track.stop();
  live = null;
}

/** A DOMException is not always an Error to `instanceof`, so its name is read by shape. */
function errorName(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    typeof error.name === 'string'
    ? error.name
    : '';
}

function failureCopy(error: unknown): string {
  if (error instanceof SpeechError) {
    if (error.reason === 'rate-limited')
      return 'Too many dictations in the last minute. Try again shortly.';
    if (error.reason === 'too-long')
      return 'That was too long to dictate in one go. Try a shorter passage.';
    if (error.reason === 'busy') return 'Dictation is busy. Try again in a moment.';
    return 'Dictation is unavailable right now. You can still type.';
  }
  const name = errorName(error);
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone permission was denied. Allow it in browser settings to dictate.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No microphone was found. Connect one and try again.';
  }
  return 'The microphone could not start. Try again.';
}

/** Throws away whatever is being recorded or recognised. With an owner, only that owner's. */
export function cancelDictation(owner?: string): void {
  if (owner !== undefined && state.owner !== null && state.owner !== owner) return;
  generation += 1;
  abort?.abort();
  abort = null;
  const current = live;
  if (current !== null) {
    closeLive();
    if (current.recorder.state !== 'inactive') current.recorder.stop();
  }
  if (state !== IDLE) update(IDLE);
}

async function openMicrophone(): Promise<MediaStream> {
  const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true };
  const preferred = readPreferredMicrophone();
  if (preferred !== null) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { ...audio, deviceId: { exact: preferred } },
      });
    } catch (error) {
      const name = errorName(error);
      // The remembered microphone is unplugged today: use whichever one there is.
      if (name !== 'OverconstrainedError' && name !== 'NotFoundError') throw error;
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio });
}

/** Starts recording a clip. `onText` is given the recognised words once, if there are any. */
export async function startDictation(options: {
  readonly owner: string;
  readonly client: NixClient;
  readonly onText: (text: string) => void;
}): Promise<void> {
  if (state.status !== 'idle') return;
  const format = recordingFormat();
  if (format === null) {
    update({
      ...IDLE,
      owner: options.owner,
      error: 'Dictation is not supported by this browser. You can still type.',
    });
    return;
  }
  generation += 1;
  const run = generation;
  update({ status: 'starting', owner: options.owner, error: null });
  let stream: MediaStream;
  try {
    stream = await openMicrophone();
  } catch (error) {
    if (run === generation) update({ ...IDLE, owner: options.owner, error: failureCopy(error) });
    return;
  }
  if (run !== generation) {
    for (const track of stream.getTracks()) track.stop();
    return;
  }
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType: format.mimeType, audioBitsPerSecond: 32_000 });
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    update({ ...IDLE, owner: options.owner, error: failureCopy(error) });
    return;
  }
  const current: Live = {
    recorder,
    stream,
    chunks: [],
    limit: setTimeout(() => {
      finishDictation(options.owner);
    }, DICTATION_LIMIT_MS),
    client: options.client,
    onText: options.onText,
    mediaType: format.mediaType,
  };
  live = current;
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size > 0) current.chunks.push(event.data);
  });
  recorder.addEventListener('stop', () => {
    void recognise(run, current);
  });
  recorder.start();
  update({ status: 'recording', owner: options.owner, error: null });
}

async function recognise(run: number, finished: Live): Promise<void> {
  if (run !== generation) return;
  const owner = state.owner;
  closeLive();
  const clip = new Blob(finished.chunks, { type: finished.mediaType });
  if (clip.size === 0) {
    update({ ...IDLE, owner, error: 'Nothing was recorded. Try again.' });
    return;
  }
  update({ status: 'transcribing', owner, error: null });
  const controller = new AbortController();
  abort = controller;
  try {
    const text = await dictate(finished.client, clip, speechVocabularyHint(), controller.signal);
    if (run !== generation) return;
    abort = null;
    if (text === '') {
      update({
        ...IDLE,
        owner,
        error: 'Nothing was heard. Check your microphone and try again.',
      });
      return;
    }
    update(IDLE);
    finished.onText(text);
  } catch (error) {
    if (run !== generation) return;
    abort = null;
    update({ ...IDLE, owner, error: failureCopy(error) });
  }
}

/** Ends the clip and sends it. With an owner, only that owner's dictation. */
export function finishDictation(owner?: string): void {
  if (live === null || state.status !== 'recording') return;
  if (owner !== undefined && state.owner !== owner) return;
  if (live.recorder.state !== 'inactive') live.recorder.stop();
}

/** Forgets an owner's last failure, once it has been read or its cause has gone. */
export function clearDictationError(owner: string): void {
  if (state.owner === owner && state.status === 'idle' && state.error !== null) update(IDLE);
}

/** What one surface needs to know about dictation: its own, and whether anybody's is live. */
export interface OwnDictation {
  readonly status: DictationState['status'];
  /** Some surface, this one or another, is dictating: there is one microphone. */
  readonly busy: boolean;
  readonly error: string | null;
}

/**
 * Dictation as one owner sees it. Another surface's failure reads as nothing here: an error
 * belongs where it happened. Each part is a primitive, so a reader re-renders only for its own.
 */
export function useOwnDictation(owner: string): OwnDictation {
  const status = useSyncExternalStore(subscribe, () =>
    state.owner === owner ? state.status : 'idle',
  );
  const busy = useSyncExternalStore(subscribe, () => state.status !== 'idle');
  const error = useSyncExternalStore(subscribe, () => (state.owner === owner ? state.error : null));
  return { status, busy, error };
}
