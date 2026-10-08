import type { NixClient } from '@nix/api-client';
import type { Editor } from '@tiptap/react';
import { useEffect } from 'react';

import { announce } from '../a11y/announcer';
import { readDevicePreference } from '../pets/device-preferences';
import {
  cancelDictation,
  canRecordDictation,
  clearDictationError,
  finishDictation,
  startDictation,
  useOwnDictation,
} from '../speech/dictation';
import {
  browserCanSpeak,
  clearSpeechError,
  speak,
  stopSpeaking,
  useOwnSpeech,
} from '../speech/speaker';
import { useSpeechStatus } from '../speech/speech-status';
import type { ToolbarSpeech } from './toolbar';

export interface NoteSpeech {
  readonly toolbar: ToolbarSpeech;
  /** What dictation is doing, for somebody who cannot hear an announcement. */
  readonly status: string | null;
  readonly error: string | null;
  readonly dismissError: () => void;
}

/**
 * Dictation into a note and reading it aloud, as the toolbar's two speech controls.
 *
 * Dictated words go in at the caret, where typing would, and never over a selection: the answer
 * arrives a moment after the clip ends, and whatever the person selected meanwhile is theirs.
 * Reading takes the selection if there is one and the whole note if not, in the voice this device
 * has chosen. Both belong to this note: leaving it ends them, because nothing outside the note
 * offers a way to stop them. Only this note's own speech and its own failures are shown here.
 */
export function useNoteSpeech(
  editor: Editor | null,
  client: NixClient,
  itemId: string,
): NoteSpeech {
  const available = useSpeechStatus(client);
  const owner = `note:${itemId}`;
  const dictation = useOwnDictation(owner);
  const speech = useOwnSpeech(owner);

  useEffect(
    () => () => {
      cancelDictation(owner);
      stopSpeaking(owner);
      clearDictationError(owner);
      clearSpeechError(owner);
    },
    [owner],
  );

  const recording = dictation.status === 'recording';
  const reading = speech.status !== 'idle';

  function onDictate(): void {
    if (editor === null) return;
    if (recording) {
      finishDictation(owner);
      return;
    }
    // One microphone for the page: while the pet or another note is dictating, this waits.
    if (dictation.busy || !editor.isEditable) return;
    void startDictation({
      owner,
      client,
      onText: (text) => {
        if (editor.isDestroyed || !editor.isEditable) return;
        // At the end of whatever is selected, collapsed, with a trailing space so the next
        // dictation or keystroke does not run into this one.
        editor.chain().focus().insertContentAt(editor.state.selection.to, `${text} `).run();
        announce('Dictation added.');
      },
    });
  }

  function onReadAloud(): void {
    if (editor === null) return;
    if (reading) {
      stopSpeaking(owner);
      return;
    }
    const { from, to, empty } = editor.state.selection;
    const text = empty
      ? editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n', ' ')
      : editor.state.doc.textBetween(from, to, '\n', ' ');
    if (text.trim() === '') {
      announce('There is nothing to read.');
      return;
    }
    speak({ owner, text, preference: readDevicePreference('voice'), client });
  }

  return {
    toolbar: {
      dictation:
        !available.dictation || !canRecordDictation()
          ? 'off'
          : dictation.status === 'starting' || recording
            ? 'recording'
            : dictation.status === 'transcribing'
              ? 'transcribing'
              : 'idle',
      onDictate,
      reading:
        !browserCanSpeak() && available.voices.length === 0 ? 'off' : reading ? 'reading' : 'idle',
      onReadAloud,
    },
    status: recording
      ? 'Listening. Press Dictate again to finish, up to a minute.'
      : dictation.status === 'transcribing'
        ? 'Recognising what you said.'
        : null,
    error:
      dictation.error ??
      speech.error ??
      (speech.fellBack ? 'The Nix voice is unavailable, so this device’s voice is reading.' : null),
    dismissError: () => {
      clearDictationError(owner);
      clearSpeechError(owner);
    },
  };
}
