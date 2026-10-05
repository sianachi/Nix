import type { NixClient } from '@nix/api-client';
import { useEffect, useRef, useState } from 'react';

import {
  cancelDictation,
  canRecordDictation,
  finishDictation,
  startDictation,
  useOwnDictation,
} from '../speech/dictation';
import {
  browserCanSpeak,
  speak as speakAloud,
  stopSpeaking,
  useOwnSpeech,
} from '../speech/speaker';
import { useSpeechStatus } from '../speech/speech-status';
import { readDevicePreference } from './device-preferences';

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  abort: () => void;
}

function recognitionConstructor() {
  const browser = window as unknown as {
    SpeechRecognition?: new () => Recognition;
    webkitSpeechRecognition?: new () => Recognition;
  };
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
}

/** The pet's name in the shared speaker and dictation stores, so it stops only its own audio. */
const OWNER = 'pet';

interface PetVoiceState {
  readonly listening: boolean;
  /** A dictated clip has been sent and its words are on their way. */
  readonly transcribing: boolean;
  /** Listening will not stop by itself: the microphone button has to be pressed again. */
  readonly pressToFinish: boolean;
  readonly speaking: boolean;
  readonly error: string;
  readonly canDictate: boolean;
  readonly canSpeak: boolean;
  readonly dictate: () => void;
  readonly speak: (text: string) => void;
  readonly stop: () => void;
}

/**
 * The pet's ears and voice.
 *
 * Two engines for each. Where the speech worker is deployed, dictation records a clip and has
 * Nix recognise it (press to start, press again to finish), and replies are spoken with the
 * device's chosen Nix voice. Anywhere else, and whenever the worker cannot be reached, the
 * browser's own recogniser and voices do the work, as they always did. Nothing listens until
 * Dictate is pressed, whichever engine it is.
 *
 * The client is what reaches the speech worker; without one the browser's engines are all there
 * is, which is also what a test that renders the hook alone gets.
 */
export function usePetVoice(
  onDictated: (text: string) => void,
  client: NixClient | null = null,
): PetVoiceState {
  const speech = useSpeechStatus(client);
  const dictation = useOwnDictation(OWNER);
  const speaker = useOwnSpeech(OWNER);
  const [browserListening, setBrowserListening] = useState(false);
  const [browserError, setBrowserError] = useState('');
  const recognition = useRef<Recognition | null>(null);
  const onText = useRef(onDictated);
  useEffect(() => {
    onText.current = onDictated;
  }, [onDictated]);

  function abortRecognition(): void {
    if (recognition.current === null) return;
    recognition.current.onresult = null;
    recognition.current.onerror = null;
    recognition.current.onend = null;
    recognition.current.abort();
    recognition.current = null;
  }

  useEffect(
    () => () => {
      if (recognition.current) {
        recognition.current.onresult = null;
        recognition.current.onerror = null;
        recognition.current.onend = null;
        recognition.current.abort();
      }
      cancelDictation(OWNER);
      stopSpeaking(OWNER);
    },
    [],
  );

  const nixDictation = client !== null && speech.dictation && canRecordDictation();

  function stop() {
    abortRecognition();
    cancelDictation(OWNER);
    stopSpeaking(OWNER);
    setBrowserListening(false);
  }

  function dictateWithBrowser() {
    const Constructor = recognitionConstructor();
    if (!Constructor) {
      setBrowserError(
        'Dictation is not supported by this browser. You can still type your message.',
      );
      return;
    }
    const session = new Constructor();
    recognition.current = session;
    session.lang = navigator.language;
    session.continuous = false;
    session.interimResults = false;
    session.onresult = (event) => {
      const text = event.results[0]?.[0]?.transcript;
      if (text) onText.current(text.slice(0, 8000));
    };
    session.onerror = (event) => {
      setBrowserListening(false);
      setBrowserError(
        event.error === 'not-allowed'
          ? 'Microphone permission was denied. Allow it in browser settings to dictate.'
          : 'Dictation stopped. Check your microphone and try again.',
      );
    };
    session.onend = () => {
      setBrowserListening(false);
    };
    try {
      session.start();
      setBrowserListening(true);
    } catch {
      setBrowserError('The microphone could not start. Try again.');
    }
  }

  function dictate() {
    // The second press of a Nix dictation is "that is all": finish the clip and send it.
    if (dictation.status === 'recording') {
      finishDictation(OWNER);
      return;
    }
    // Its own clip is being recognised, or another surface holds the one microphone.
    if (dictation.busy) return;
    // And the second press of the browser's recogniser is "never mind".
    if (browserListening) {
      stop();
      return;
    }
    stop();
    setBrowserError('');
    if (nixDictation) {
      void startDictation({
        owner: OWNER,
        client,
        onText: (text) => {
          onText.current(text.slice(0, 8000));
        },
      });
      return;
    }
    dictateWithBrowser();
  }

  function speak(text: string) {
    // The speaker replaces whatever it was saying itself; only the microphone is closed here.
    abortRecognition();
    cancelDictation(OWNER);
    setBrowserListening(false);
    setBrowserError('');
    speakAloud({ owner: OWNER, text, preference: readDevicePreference('voice'), client });
  }

  const nixListening = dictation.status === 'starting' || dictation.status === 'recording';
  return {
    listening: browserListening || nixListening,
    transcribing: dictation.status === 'transcribing',
    pressToFinish: nixListening,
    speaking: speaker.status !== 'idle',
    // Only the pet's own trouble: a note's failed dictation is the note's to report.
    error:
      browserError ||
      (dictation.error ?? '') ||
      (speaker.error ?? '') ||
      (speaker.fellBack ? 'The Nix voice is unavailable, so this device’s voice is speaking.' : ''),
    dictate,
    speak,
    stop,
    canDictate: nixDictation || Boolean(recognitionConstructor()),
    canSpeak: browserCanSpeak() || speech.voices.length > 0,
  };
}
