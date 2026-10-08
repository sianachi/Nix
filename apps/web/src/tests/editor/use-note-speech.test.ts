import type { NixClient } from '@nix/api-client';
import type { Editor } from '@tiptap/react';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useNoteSpeech } from '../../editor/use-note-speech';
import type { OwnDictation } from '../../speech/dictation';
import type { OwnSpeech } from '../../speech/speaker';

const speech = vi.hoisted(() => {
  const dictation: OwnDictation = { status: 'idle', busy: false, error: null };
  const speaker: OwnSpeech = { status: 'idle', fellBack: false, error: null };
  return {
    status: { voices: [] as unknown[], dictation: true, transcription: true },
    dictation,
    speaker,
    owners: [] as string[],
    startDictation: vi.fn(),
    finishDictation: vi.fn(),
    cancelDictation: vi.fn(),
    clearDictationError: vi.fn(),
    speak: vi.fn(),
    stopSpeaking: vi.fn(),
    clearSpeechError: vi.fn(),
    canRecord: true,
    canSpeak: true,
  };
});

vi.mock('../../speech/speech-status', () => ({ useSpeechStatus: () => speech.status }));
vi.mock('../../speech/dictation', () => ({
  // The store is asked for this note's own dictation, by name.
  useOwnDictation: (owner: string) => {
    speech.owners.push(owner);
    return speech.dictation;
  },
  canRecordDictation: () => speech.canRecord,
  startDictation: speech.startDictation,
  finishDictation: speech.finishDictation,
  cancelDictation: speech.cancelDictation,
  clearDictationError: speech.clearDictationError,
}));
vi.mock('../../speech/speaker', () => ({
  useOwnSpeech: () => speech.speaker,
  browserCanSpeak: () => speech.canSpeak,
  speak: speech.speak,
  stopSpeaking: speech.stopSpeaking,
  clearSpeechError: speech.clearSpeechError,
}));
vi.mock('../../pets/device-preferences', () => ({
  readDevicePreference: () => 'nix:en_GB-cori-high',
}));

const client = {} as NixClient;
const inserted = vi.fn();

function editor(selection: { from: number; to: number }): Editor {
  const text = 'Agenda for Monday. Budget and hiring.';
  return {
    isDestroyed: false,
    isEditable: true,
    state: {
      selection: { ...selection, empty: selection.from === selection.to },
      doc: {
        content: { size: text.length },
        textBetween: (from: number, to: number) => text.slice(from, to),
      },
    },
    chain: () => ({
      focus: () => ({
        insertContentAt: (position: number, content: string) => ({
          run: () => {
            inserted(position, content);
            return true;
          },
        }),
      }),
    }),
  } as unknown as Editor;
}

beforeEach(() => {
  speech.status = { voices: [], dictation: true, transcription: true };
  speech.dictation = { status: 'idle', busy: false, error: null };
  speech.speaker = { status: 'idle', fellBack: false, error: null };
  speech.owners = [];
  speech.canRecord = true;
  speech.canSpeak = true;
  for (const mock of [
    speech.startDictation,
    speech.finishDictation,
    speech.cancelDictation,
    speech.clearDictationError,
    speech.speak,
    speech.stopSpeaking,
    speech.clearSpeechError,
    inserted,
  ]) {
    mock.mockReset();
  }
});

describe('speech in a note', () => {
  it('does not insert a late dictation result after the note becomes read-only', () => {
    const current = editor({ from: 0, to: 0 });
    const { result } = renderHook(() => useNoteSpeech(current, client, 'note-1'));
    result.current.toolbar.onDictate();
    const started = speech.startDictation.mock.calls[0]?.[0] as { onText: (text: string) => void };
    Reflect.set(current, 'isEditable', false);
    started.onText('A late transcript.');
    expect(inserted).not.toHaveBeenCalled();
    speech.startDictation.mockClear();
    result.current.toolbar.onDictate();
    expect(speech.startDictation).not.toHaveBeenCalled();
  });

  it('puts dictated words after the selection, never over it, with room after them', () => {
    const { result } = renderHook(() =>
      useNoteSpeech(editor({ from: 3, to: 9 }), client, 'note-1'),
    );
    expect(result.current.toolbar.dictation).toBe('idle');
    expect(speech.owners).toContain('note:note-1');

    result.current.toolbar.onDictate();

    const started = speech.startDictation.mock.calls[0]?.[0] as {
      owner: string;
      onText: (text: string) => void;
    };
    expect(started.owner).toBe('note:note-1');
    started.onText('Call Ada on Friday.');
    expect(inserted).toHaveBeenCalledWith(9, 'Call Ada on Friday. ');
  });

  it('finishes its own dictation on the second press and says what it is doing meanwhile', () => {
    speech.dictation = { status: 'recording', busy: true, error: null };
    const { result } = renderHook(() =>
      useNoteSpeech(editor({ from: 0, to: 0 }), client, 'note-1'),
    );
    expect(result.current.toolbar.dictation).toBe('recording');
    expect(result.current.status).toContain('Press Dictate again to finish');

    result.current.toolbar.onDictate();

    expect(speech.finishDictation).toHaveBeenCalledWith('note:note-1');
  });

  it('waits while another surface holds the microphone, and shows none of its trouble', () => {
    // The pet is dictating: busy, but not this note's, and whatever goes wrong there is the pet's.
    speech.dictation = { status: 'idle', busy: true, error: null };
    const { result } = renderHook(() =>
      useNoteSpeech(editor({ from: 0, to: 0 }), client, 'note-2'),
    );

    expect(result.current.toolbar.dictation).toBe('idle');
    expect(result.current.error).toBeNull();
    result.current.toolbar.onDictate();
    expect(speech.startDictation).not.toHaveBeenCalled();
  });

  it('reads the selection if there is one and the whole note if not', () => {
    const selected = renderHook(() => useNoteSpeech(editor({ from: 0, to: 18 }), client, 'note-1'));
    selected.result.current.toolbar.onReadAloud();
    expect(speech.speak).toHaveBeenLastCalledWith({
      owner: 'note:note-1',
      text: 'Agenda for Monday.',
      preference: 'nix:en_GB-cori-high',
      client,
    });

    const whole = renderHook(() => useNoteSpeech(editor({ from: 5, to: 5 }), client, 'note-1'));
    whole.result.current.toolbar.onReadAloud();
    expect((speech.speak.mock.lastCall?.[0] as { text: string }).text).toBe(
      'Agenda for Monday. Budget and hiring.',
    );
  });

  it('stops reading on the second press, and when the note is left', () => {
    speech.speaker = { status: 'speaking', fellBack: false, error: null };
    const view = renderHook(() => useNoteSpeech(editor({ from: 0, to: 0 }), client, 'note-1'));
    expect(view.result.current.toolbar.reading).toBe('reading');

    view.result.current.toolbar.onReadAloud();
    expect(speech.stopSpeaking).toHaveBeenCalledWith('note:note-1');
    expect(speech.speak).not.toHaveBeenCalled();

    view.unmount();
    expect(speech.cancelDictation).toHaveBeenCalledWith('note:note-1');
    expect(speech.stopSpeaking).toHaveBeenCalledTimes(2);
  });

  it('offers only what can work here', () => {
    speech.status = { voices: [], dictation: false, transcription: false };
    speech.canSpeak = false;
    const { result } = renderHook(() =>
      useNoteSpeech(editor({ from: 0, to: 0 }), client, 'note-1'),
    );

    expect(result.current.toolbar.dictation).toBe('off');
    expect(result.current.toolbar.reading).toBe('off');
  });

  it('shows its own failure until it is dismissed', () => {
    speech.dictation = { status: 'idle', busy: false, error: 'Nothing was heard.' };
    const { result } = renderHook(() =>
      useNoteSpeech(editor({ from: 0, to: 0 }), client, 'note-1'),
    );
    expect(result.current.error).toBe('Nothing was heard.');

    result.current.dismissError();

    expect(speech.clearDictationError).toHaveBeenCalledWith('note:note-1');
    expect(speech.clearSpeechError).toHaveBeenCalledWith('note:note-1');
  });

  it('says when the device’s voice stood in for the Nix one', () => {
    speech.speaker = { status: 'speaking', fellBack: true, error: null };
    const { result } = renderHook(() =>
      useNoteSpeech(editor({ from: 0, to: 0 }), client, 'note-1'),
    );

    expect(result.current.error).toContain('Nix voice is unavailable');
  });
});
