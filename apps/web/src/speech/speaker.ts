import type { NixClient } from '@nix/api-client';
import { useSyncExternalStore } from 'react';

import { speechPassages } from '../lib/speech-passages';
import { SpeechError, synthesize } from './speech-client';

/**
 * The one voice the application speaks with.
 *
 * A module and not a component, for the audio player's reason: speech belongs to the page, and a
 * note being read aloud should not stop because the control that started it scrolled away. Two
 * engines sit behind it. A Nix voice is made on the server a passage at a time, the next one
 * fetched while the current one plays, and is the same on every device. The browser's own voice
 * is the fallback, used when no Nix voice is chosen or the speech worker cannot be reached; it
 * starts at once and sounds like whatever the device ships.
 *
 * Whoever starts speech names itself, and only that owner's `stop` ends it, so closing one
 * surface does not silence another.
 */

/** A device's voice preference names a Nix voice with this prefix; anything else is a browser voice. */
export const NIX_VOICE_PREFIX = 'nix:';
/** The browser engine takes the text whole, so it is bounded here as the pet always bounded it. */
const BROWSER_TEXT_LIMIT = 16_000;

export type SpeakerEngine = 'nix' | 'browser';

export interface SpeakerState {
  readonly status: 'idle' | 'loading' | 'speaking';
  readonly owner: string | null;
  readonly engine: SpeakerEngine | null;
  /** A Nix voice was asked for and could not be had, so the device's own voice is speaking. */
  readonly fellBack: boolean;
  readonly error: string | null;
}

const IDLE: SpeakerState = {
  status: 'idle',
  owner: null,
  engine: null,
  fellBack: false,
  error: null,
};

let state: SpeakerState = IDLE;
const listeners = new Set<() => void>();
/** Bumped whenever speech starts or stops, so an answer to an old request is ignored. */
let generation = 0;
let element: HTMLAudioElement | null = null;
let playingUrl: string | null = null;
let utterance: SpeechSynthesisUtterance | null = null;
let abort: AbortController | null = null;

function update(next: SpeakerState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSpeakerState(): SpeakerState {
  return state;
}

export function useSpeakerState(): SpeakerState {
  return useSyncExternalStore(subscribe, getSpeakerState, getSpeakerState);
}

export function browserCanSpeak(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

function release(): void {
  abort?.abort();
  abort = null;
  if (element !== null) {
    element.onended = null;
    element.onerror = null;
    element.pause();
    element.removeAttribute('src');
  }
  if (playingUrl !== null) {
    URL.revokeObjectURL(playingUrl);
    playingUrl = null;
  }
  if (utterance !== null) {
    utterance.onend = null;
    utterance.onerror = null;
    utterance = null;
  }
  if (browserCanSpeak()) window.speechSynthesis.cancel();
}

/** What one surface needs to know about the speaker: its own speech, and nobody else's. */
export interface OwnSpeech {
  readonly status: SpeakerState['status'];
  readonly fellBack: boolean;
  readonly error: string | null;
}

/**
 * The speaker as one owner sees it. Somebody else's speech, and somebody else's failure, read as
 * silence: an error belongs on the surface that caused it and nowhere else. Each part is a
 * primitive, so a reader re-renders only when its own part changes.
 */
export function useOwnSpeech(owner: string): OwnSpeech {
  const status = useSyncExternalStore(subscribe, () =>
    state.owner === owner ? state.status : 'idle',
  );
  const fellBack = useSyncExternalStore(subscribe, () => state.owner === owner && state.fellBack);
  const error = useSyncExternalStore(subscribe, () => (state.owner === owner ? state.error : null));
  return { status, fellBack, error };
}

/** Forgets an owner's last failure, once it has been read or its cause has gone. */
export function clearSpeechError(owner: string): void {
  if (state.owner === owner && state.status === 'idle' && state.error !== null) update(IDLE);
}

/** Stops speech. With an owner, only that owner's; without one, whatever is speaking. */
export function stopSpeaking(owner?: string): void {
  if (owner !== undefined && state.owner !== null && state.owner !== owner) return;
  generation += 1;
  release();
  if (state !== IDLE) update(IDLE);
}

function speakWithBrowser(
  run: number,
  owner: string,
  text: string,
  voiceUri: string,
  fellBack: boolean,
): void {
  if (!browserCanSpeak()) {
    update({ ...IDLE, owner, error: 'Speaking is not supported by this browser.' });
    return;
  }
  const value = new SpeechSynthesisUtterance(text.slice(0, BROWSER_TEXT_LIMIT));
  const preferred = window.speechSynthesis.getVoices().find((entry) => entry.voiceURI === voiceUri);
  if (preferred !== undefined) value.voice = preferred;
  const done = (): void => {
    if (run !== generation) return;
    utterance = null;
    update(IDLE);
  };
  value.onend = done;
  value.onerror = done;
  utterance = value;
  update({ status: 'speaking', owner, engine: 'browser', fellBack, error: null });
  window.speechSynthesis.speak(value);
}

async function speakWithNix(
  run: number,
  owner: string,
  client: NixClient,
  voice: string,
  text: string,
): Promise<void> {
  const passages = speechPassages(text);
  if (passages.length === 0) {
    update(IDLE);
    return;
  }
  const controller = new AbortController();
  abort = controller;
  update({ status: 'loading', owner, engine: 'nix', fellBack: false, error: null });

  const fetchPassage = (index: number): Promise<Blob> =>
    synthesize(client, voice, passages[index] ?? '', controller.signal);
  let next: Promise<Blob> = fetchPassage(0);
  for (let index = 0; index < passages.length; index += 1) {
    let audio: Blob;
    try {
      audio = await next;
    } catch (error) {
      if (run !== generation) return;
      // Before anything has been heard, the device's own voice takes over and says so. Part
      // way through, switching voices mid-sentence would be worse than stopping.
      if (index === 0 && browserCanSpeak()) {
        release();
        speakWithBrowser(run, owner, text, '', true);
        return;
      }
      release();
      update({
        ...IDLE,
        owner,
        error:
          error instanceof SpeechError && error.reason === 'rate-limited'
            ? 'Too much has been read aloud in the last minute. Try again shortly.'
            : 'The voice stopped responding. Try again.',
      });
      return;
    }
    if (run !== generation) return;
    if (index + 1 < passages.length) {
      next = fetchPassage(index + 1);
      // Observed here so a failure that arrives while this passage plays is not unhandled.
      next.catch(() => undefined);
    }
    element ??= new Audio();
    const player = element;
    if (playingUrl !== null) URL.revokeObjectURL(playingUrl);
    playingUrl = URL.createObjectURL(audio);
    const finished = new Promise<boolean>((resolve) => {
      player.onended = () => {
        resolve(true);
      };
      player.onerror = () => {
        resolve(false);
      };
    });
    player.src = playingUrl;
    update({ status: 'speaking', owner, engine: 'nix', fellBack: false, error: null });
    try {
      await player.play();
    } catch {
      if (run !== generation) return;
      release();
      update({ ...IDLE, owner, error: 'The browser would not start playback. Try again.' });
      return;
    }
    const played = await finished;
    if (run !== generation) return;
    if (!played) {
      release();
      update({ ...IDLE, owner, error: 'The voice could not be played. Try again.' });
      return;
    }
  }
  release();
  update(IDLE);
}

/**
 * Speaks text. `preference` is the device's voice setting: a Nix voice when it carries the
 * prefix and there is a client to ask, otherwise a browser voice URI or empty for its default.
 */
export function speak(options: {
  readonly owner: string;
  readonly text: string;
  readonly preference: string;
  readonly client: NixClient | null;
}): void {
  generation += 1;
  const run = generation;
  release();
  const text = options.text.trim();
  if (text === '') {
    update(IDLE);
    return;
  }
  if (options.client !== null && options.preference.startsWith(NIX_VOICE_PREFIX)) {
    void speakWithNix(
      run,
      options.owner,
      options.client,
      options.preference.slice(NIX_VOICE_PREFIX.length),
      text,
    );
    return;
  }
  speakWithBrowser(
    run,
    options.owner,
    text,
    options.preference.startsWith(NIX_VOICE_PREFIX) ? '' : options.preference,
    false,
  );
}
