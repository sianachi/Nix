import type { NixClient } from '@nix/api-client';
import { useEffect, useState } from 'react';

import { fetchSpeechStatus, type SpeechStatus } from './speech-client';

/**
 * What the speech worker offers, asked once and remembered.
 *
 * Whether Nix has its own voices and its own dictation decides which controls are shown and
 * which engine a click reaches, so it is needed before the click and cannot be asked at it. One
 * question per page load answers it for every control; a "no" is asked again after a while,
 * because a worker that was restarting should not stay written off for the session.
 */

const UNAVAILABLE: SpeechStatus = { voices: [], dictation: false, transcription: false };
const RETRY_AFTER_MS = 5 * 60 * 1000;

let known: SpeechStatus | null = null;
let asked: Promise<SpeechStatus> | null = null;
let failedAt = 0;
const listeners = new Set<() => void>();

/** The answer if there is one yet; otherwise nothing is offered, which is the safe reading. */
export function speechStatusNow(): SpeechStatus {
  return known ?? UNAVAILABLE;
}

export function loadSpeechStatus(client: NixClient): Promise<SpeechStatus> {
  if (known !== null && (known !== UNAVAILABLE || Date.now() - failedAt < RETRY_AFTER_MS)) {
    return Promise.resolve(known);
  }
  asked ??= fetchSpeechStatus(client)
    .catch(() => {
      failedAt = Date.now();
      return UNAVAILABLE;
    })
    .then((status) => {
      known = status;
      asked = null;
      for (const listener of listeners) listener();
      return status;
    });
  return asked;
}

/** Forgets the answer. For signing out, and for tests. */
export function forgetSpeechStatus(): void {
  known = null;
  asked = null;
  failedAt = 0;
}

/** The speech worker's offer, for a component; nothing is offered until the answer is in. */
export function useSpeechStatus(client: NixClient | null): SpeechStatus {
  const [status, setStatus] = useState(speechStatusNow);
  useEffect(() => {
    if (client === null) return;
    const update = (): void => {
      setStatus(speechStatusNow());
    };
    listeners.add(update);
    void loadSpeechStatus(client).then(update);
    return () => {
      listeners.delete(update);
    };
  }, [client]);
  return status;
}
