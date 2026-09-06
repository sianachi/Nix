import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePetVoice } from '../../pets/use-pet-voice';

describe('companion audio privacy and lifecycle', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not open the microphone until explicitly requested, and aborts on unmount', () => {
    const start = vi.fn();
    const abort = vi.fn();
    class Recognition {
      lang = '';
      continuous = false;
      interimResults = false;
      onresult = null;
      onerror = null;
      onend = null;
      start = start;
      abort = abort;
    }
    vi.stubGlobal('SpeechRecognition', Recognition);
    const view = renderHook(() => usePetVoice(vi.fn()));
    expect(start).not.toHaveBeenCalled();
    act(() => {
      view.result.current.dictate();
    });
    expect(start).toHaveBeenCalledOnce();
    expect(view.result.current.listening).toBe(true);
    view.unmount();
    expect(abort).toHaveBeenCalledOnce();
  });

  it('reports unsupported dictation instead of pretending to listen', () => {
    vi.stubGlobal('SpeechRecognition', undefined);
    vi.stubGlobal('webkitSpeechRecognition', undefined);
    const { result } = renderHook(() => usePetVoice(vi.fn()));
    act(() => {
      result.current.dictate();
    });
    expect(result.current.canDictate).toBe(false);
    expect(result.current.listening).toBe(false);
    expect(result.current.error).toContain('not supported');
  });

  it('starts narration explicitly and cancels it when the panel closes', () => {
    const speak = vi.fn();
    const cancel = vi.fn();
    class Utterance {
      onend = null;
      onerror = null;
    }
    vi.stubGlobal('SpeechSynthesisUtterance', Utterance);
    vi.stubGlobal('speechSynthesis', { speak, cancel, getVoices: () => [] });
    const view = renderHook(() => usePetVoice(vi.fn()));
    expect(speak).not.toHaveBeenCalled();
    act(() => {
      view.result.current.speak('A reply');
    });
    expect(speak).toHaveBeenCalledOnce();
    expect(view.result.current.speaking).toBe(true);
    view.unmount();
    expect(cancel).toHaveBeenCalledTimes(2);
  });
});
