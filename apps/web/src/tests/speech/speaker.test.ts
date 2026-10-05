import type { NixClient } from '@nix/api-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Speaker from '../../speech/speaker';
import type * as SpeechClient from '../../speech/speech-client';

const api = vi.hoisted(() => ({ synthesize: vi.fn() }));
vi.mock('../../speech/speech-client', async (original) => ({
  ...(await original<typeof SpeechClient>()),
  synthesize: api.synthesize,
}));

class FakeAudio {
  static instances: FakeAudio[] = [];
  src = '';
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play = vi.fn(() => Promise.resolve());
  pause = vi.fn();
  constructor() {
    FakeAudio.instances.push(this);
  }
  removeAttribute(): void {
    this.src = '';
  }
}

class Utterance {
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  voice: unknown = null;
  constructor(readonly text: string) {}
}

const synthesis = {
  speak: vi.fn(),
  cancel: vi.fn(),
  getVoices: () => [{ voiceURI: 'device-voice' }],
};
const client = {} as NixClient;
let speaker: typeof Speaker;

async function settle(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
}

beforeEach(async () => {
  vi.resetModules();
  FakeAudio.instances = [];
  api.synthesize.mockReset().mockImplementation(() => Promise.resolve(new Blob(['mp3'])));
  synthesis.speak.mockReset();
  synthesis.cancel.mockReset();
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('SpeechSynthesisUtterance', Utterance);
  vi.stubGlobal('speechSynthesis', synthesis);
  Object.defineProperty(URL, 'createObjectURL', {
    value: () => 'blob:passage',
    configurable: true,
  });
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => undefined, configurable: true });
  speaker = await import('../../speech/speaker');
});
afterEach(() => {
  speaker.stopSpeaking();
  vi.unstubAllGlobals();
});

const TWO_PASSAGES = `${'First passage. '.repeat(30)}${'Second passage. '.repeat(30)}`;

describe('speaking with a Nix voice', () => {
  it('speaks a passage at a time, with the next one already on its way', async () => {
    speaker.speak({ owner: 'note', text: TWO_PASSAGES, preference: 'nix:en_GB-cori-high', client });
    expect(speaker.getSpeakerState()).toMatchObject({ status: 'loading', engine: 'nix' });
    await settle();

    expect(speaker.getSpeakerState()).toMatchObject({ status: 'speaking', owner: 'note' });
    // The second passage was asked for while the first plays, and with the chosen voice.
    expect(api.synthesize).toHaveBeenCalledTimes(2);
    expect(api.synthesize.mock.calls[0]?.[1]).toBe('en_GB-cori-high');
    expect(synthesis.speak).not.toHaveBeenCalled();

    // A short opening passage, then two full ones: each starts when the one before it ends.
    for (let passage = 0; passage < 3; passage += 1) {
      FakeAudio.instances[0]?.onended?.();
      await settle();
    }
    expect(FakeAudio.instances[0]?.play).toHaveBeenCalledTimes(3);
    expect(api.synthesize).toHaveBeenCalledTimes(3);
    expect((api.synthesize.mock.calls[0]?.[2] as string).length).toBeLessThanOrEqual(160);

    expect(speaker.getSpeakerState()).toMatchObject({ status: 'idle', error: null });
  });

  it('hands over to the device’s voice, and says so, when nothing has been heard yet', async () => {
    const { SpeechError } = await import('../../speech/speech-client');
    api.synthesize.mockRejectedValue(new SpeechError('unavailable'));

    speaker.speak({ owner: 'pet', text: 'A reply.', preference: 'nix:en_US-ryan-high', client });
    await settle();

    expect(synthesis.speak).toHaveBeenCalledOnce();
    expect(speaker.getSpeakerState()).toMatchObject({
      status: 'speaking',
      engine: 'browser',
      fellBack: true,
    });
  });

  it('stops with a reason rather than changing voice part way through', async () => {
    const { SpeechError } = await import('../../speech/speech-client');
    api.synthesize
      .mockResolvedValueOnce(new Blob(['mp3']))
      .mockRejectedValueOnce(new SpeechError('rate-limited'));

    speaker.speak({ owner: 'note', text: TWO_PASSAGES, preference: 'nix:v', client });
    await settle();
    FakeAudio.instances[0]?.onended?.();
    await settle();

    expect(synthesis.speak).not.toHaveBeenCalled();
    expect(speaker.getSpeakerState()).toMatchObject({ status: 'idle' });
    expect(speaker.getSpeakerState().error).toContain('last minute');
    // The failure stays the note's own: another surface stopping its speech does not wipe it.
    expect(speaker.getSpeakerState().owner).toBe('note');
    speaker.stopSpeaking('pet');
    speaker.clearSpeechError('pet');
    expect(speaker.getSpeakerState().error).toContain('last minute');
    speaker.clearSpeechError('note');
    expect(speaker.getSpeakerState().error).toBeNull();
  });

  it('is stopped only by whoever started it', async () => {
    speaker.speak({ owner: 'note', text: 'Hello there.', preference: 'nix:v', client });
    await settle();

    speaker.stopSpeaking('pet');
    expect(speaker.getSpeakerState().status).toBe('speaking');

    speaker.stopSpeaking('note');
    expect(speaker.getSpeakerState().status).toBe('idle');
    expect(FakeAudio.instances[0]?.pause).toHaveBeenCalled();
    // A passage that finishes after the stop starts nothing.
    FakeAudio.instances[0]?.onended?.();
    await settle();
    expect(speaker.getSpeakerState().status).toBe('idle');
  });
});

describe('speaking with the device’s voice', () => {
  it('uses the chosen browser voice and never asks the speech worker', () => {
    speaker.speak({ owner: 'pet', text: 'A reply.', preference: 'device-voice', client });

    expect(api.synthesize).not.toHaveBeenCalled();
    const spoken = synthesis.speak.mock.calls[0]?.[0] as Utterance;
    expect(spoken.text).toBe('A reply.');
    expect(spoken.voice).toEqual({ voiceURI: 'device-voice' });
    expect(speaker.getSpeakerState()).toMatchObject({ engine: 'browser', fellBack: false });

    spoken.onend?.();
    expect(speaker.getSpeakerState().status).toBe('idle');
  });

  it('uses the device’s default for a Nix voice when there is no client to ask', () => {
    speaker.speak({
      owner: 'pet',
      text: 'A reply.',
      preference: 'nix:en_US-ryan-high',
      client: null,
    });

    expect((synthesis.speak.mock.calls[0]?.[0] as Utterance).voice).toBeNull();
  });

  it('says nothing for nothing', () => {
    speaker.speak({ owner: 'pet', text: '   ', preference: '', client });

    expect(synthesis.speak).not.toHaveBeenCalled();
    expect(speaker.getSpeakerState().status).toBe('idle');
  });
});
