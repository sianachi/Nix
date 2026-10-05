import type { NixClient } from '@nix/api-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Capture from '../../recording/capture';
import type * as Dictation from '../../speech/dictation';
import type * as SpeechClient from '../../speech/speech-client';
import { FakeMediaRecorder, lastRecorder } from '../recording/fake-recorder';
import { memoryStorage } from '../views/suggest/suggest-fixtures';

const api = vi.hoisted(() => ({ dictate: vi.fn() }));
vi.mock('../../speech/speech-client', async (original) => ({
  ...(await original<typeof SpeechClient>()),
  dictate: api.dictate,
}));
vi.mock('../../recording/capture', async (original) => ({
  ...(await original<typeof Capture>()),
  recordingFormat: () => ({
    mimeType: 'audio/webm;codecs=opus',
    mediaType: 'audio/webm',
    extension: 'weba',
  }),
}));

const client = {} as NixClient;
const getUserMedia = vi.fn();
const track = { stop: vi.fn() };
let dictation: typeof Dictation;
const onText = vi.fn();

async function settle(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  FakeMediaRecorder.instances = [];
  track.stop.mockReset();
  onText.mockReset();
  api.dictate.mockReset().mockResolvedValue('Remind me to call Ada.');
  getUserMedia.mockReset().mockResolvedValue({ getTracks: () => [track] });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  // The same instance the store under test reads, which a static import would not be.
  const vocabulary = await import('../../lib/speech-vocabulary');
  vocabulary.rememberSpeechVocabulary(['Ada Lovelace']);
  dictation = await import('../../speech/dictation');
});
afterEach(() => {
  dictation.cancelDictation();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function begin(owner = 'note'): Promise<void> {
  await dictation.startDictation({ owner, client, onText });
}

describe('dictating through Nix', () => {
  it('records until told to finish, then hands back the words', async () => {
    await begin();
    expect(dictation.getDictationState()).toMatchObject({ status: 'recording', owner: 'note' });
    expect(api.dictate).not.toHaveBeenCalled();

    lastRecorder().emit(new Blob([new Uint8Array(64)]));
    dictation.finishDictation('note');
    expect(dictation.getDictationState().status).toBe('transcribing');
    await settle();

    expect(onText).toHaveBeenCalledWith('Remind me to call Ada.');
    expect(dictation.getDictationState()).toMatchObject({ status: 'idle', error: null });
    // The microphone is closed the moment the clip ends, and the workspace's names go with it.
    expect(track.stop).toHaveBeenCalled();
    const [, clip, hint] = api.dictate.mock.calls[0] as [NixClient, Blob, string];
    expect(clip.type).toBe('audio/webm');
    expect(hint).toBe('Ada Lovelace');
  });

  it('says so when nothing was heard, and inserts nothing', async () => {
    api.dictate.mockResolvedValue('');
    await begin();
    lastRecorder().emit(new Blob([new Uint8Array(8)]));
    dictation.finishDictation();
    await settle();

    expect(onText).not.toHaveBeenCalled();
    expect(dictation.getDictationState().error).toContain('Nothing was heard');
  });

  it('explains a refused microphone', async () => {
    getUserMedia.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));

    await begin();

    expect(dictation.getDictationState()).toMatchObject({ status: 'idle' });
    expect(dictation.getDictationState().error).toContain('permission was denied');
  });

  it('throws the clip away when cancelled', async () => {
    await begin();
    lastRecorder().emit(new Blob([new Uint8Array(64)]));

    dictation.cancelDictation('note');
    await settle();

    expect(api.dictate).not.toHaveBeenCalled();
    expect(onText).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
    expect(dictation.getDictationState()).toMatchObject({ status: 'idle', error: null });
  });

  it('belongs to the surface that started it', async () => {
    await begin('pet');

    await begin('note');
    dictation.finishDictation('note');
    dictation.cancelDictation('note');

    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(dictation.getDictationState()).toMatchObject({ status: 'recording', owner: 'pet' });
  });

  it('ends a clip by itself at the limit', async () => {
    await begin();
    lastRecorder().emit(new Blob([new Uint8Array(64)]));

    vi.advanceTimersByTime(dictation.DICTATION_LIMIT_MS);
    await settle();

    expect(api.dictate).toHaveBeenCalledOnce();
  });

  it('turns a busy or unreachable speech worker into words', async () => {
    const { SpeechError } = await import('../../speech/speech-client');
    api.dictate.mockRejectedValue(new SpeechError('unavailable'));
    await begin();
    lastRecorder().emit(new Blob([new Uint8Array(64)]));
    dictation.finishDictation();
    await settle();

    expect(dictation.getDictationState().error).toContain('unavailable right now');
    // The failure is the note's: the pet's microphone button neither shows it nor clears it.
    expect(dictation.getDictationState().owner).toBe('note');
    dictation.cancelDictation('pet');
    dictation.clearDictationError('pet');
    expect(dictation.getDictationState().error).toContain('unavailable right now');
    dictation.clearDictationError('note');
    expect(dictation.getDictationState().error).toBeNull();
  });
});
