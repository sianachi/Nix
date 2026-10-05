import { useEffect, useRef, useState } from 'react';
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

interface PetVoiceState {
  readonly listening: boolean;
  readonly speaking: boolean;
  readonly error: string;
  readonly canDictate: boolean;
  readonly canSpeak: boolean;
  readonly dictate: () => void;
  readonly speak: (text: string) => void;
  readonly stop: () => void;
}

export function usePetVoice(onDictated: (text: string) => void): PetVoiceState {
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState('');
  const recognition = useRef<Recognition | null>(null);
  const utterance = useRef<SpeechSynthesisUtterance | null>(null);
  const onText = useRef(onDictated);
  useEffect(() => {
    onText.current = onDictated;
  }, [onDictated]);
  useEffect(
    () => () => {
      if (recognition.current) {
        recognition.current.onresult = null;
        recognition.current.onerror = null;
        recognition.current.onend = null;
        recognition.current.abort();
      }
      if (utterance.current) {
        utterance.current.onend = null;
        utterance.current.onerror = null;
        window.speechSynthesis.cancel();
      }
    },
    [],
  );

  function stop() {
    if (recognition.current) {
      recognition.current.onresult = null;
      recognition.current.onerror = null;
      recognition.current.onend = null;
      recognition.current.abort();
      recognition.current = null;
    }
    if (utterance.current) {
      utterance.current.onend = null;
      utterance.current.onerror = null;
      utterance.current = null;
    }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    setListening(false);
    setSpeaking(false);
  }

  function dictate() {
    stop();
    setError('');
    const Constructor = recognitionConstructor();
    if (!Constructor) {
      setError('Dictation is not supported by this browser. You can still type your message.');
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
      setListening(false);
      setError(
        event.error === 'not-allowed'
          ? 'Microphone permission was denied. Allow it in browser settings to dictate.'
          : 'Dictation stopped. Check your microphone and try again.',
      );
    };
    session.onend = () => {
      setListening(false);
    };
    try {
      session.start();
      setListening(true);
    } catch {
      setError('The microphone could not start. Try again.');
    }
  }

  function speak(text: string) {
    stop();
    setError('');
    if (!('speechSynthesis' in window)) {
      setError('Speaking is not supported by this browser.');
      return;
    }
    const value = new SpeechSynthesisUtterance(text.slice(0, 16000));
    utterance.current = value;
    const preferred = window.speechSynthesis
      .getVoices()
      .find((entry) => entry.voiceURI === readDevicePreference('voice'));
    if (preferred) value.voice = preferred;
    value.onend = () => {
      setSpeaking(false);
      utterance.current = null;
    };
    value.onerror = () => {
      setSpeaking(false);
      utterance.current = null;
    };
    setSpeaking(true);
    window.speechSynthesis.speak(value);
  }
  return {
    listening,
    speaking,
    error,
    dictate,
    speak,
    stop,
    canDictate: Boolean(recognitionConstructor()),
    canSpeak: 'speechSynthesis' in window,
  };
}
