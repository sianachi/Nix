import { afterEach, describe, expect, it, vi } from 'vitest';

import { openCapture } from '../../recording/capture';

function stream() {
  const stop = vi.fn();
  const track = { stop, addEventListener: vi.fn() };
  return {
    stop,
    media: { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream,
  };
}

function installCapture() {
  const microphone = stream();
  const shared = stream();
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: vi.fn().mockResolvedValue(microphone.media),
      getDisplayMedia: vi.fn().mockResolvedValue(shared.media),
    },
  });
  vi.stubGlobal('MediaRecorder', { isTypeSupported: () => true });
  return { microphone, shared };
}

afterEach(() => vi.unstubAllGlobals());

describe('mixed-source recording capture', () => {
  it('releases both sources when the browser cannot create an audio context', async () => {
    const { microphone, shared } = installCapture();
    vi.stubGlobal('AudioContext', function unavailableAudioContext(): never {
      throw new Error('limit');
    });
    await expect(openCapture({ deviceId: null, shareAudio: true })).rejects.toMatchObject({
      reason: 'failed',
    });
    expect(microphone.stop).toHaveBeenCalledOnce();
    expect(shared.stop).toHaveBeenCalledOnce();
  });

  it('releases capture and closes the mixer when the audio context cannot run', async () => {
    const { microphone, shared } = installCapture();
    const close = vi.fn().mockResolvedValue(undefined);
    const connect = vi.fn();
    vi.stubGlobal(
      'AudioContext',
      class {
        close = close;
        resume = vi.fn().mockRejectedValue(new Error('blocked'));
        createChannelMerger = () => ({ connect });
        createMediaStreamDestination = () => ({ stream: {} });
        createMediaStreamSource = () => ({ connect });
      },
    );
    await expect(openCapture({ deviceId: null, shareAudio: true })).rejects.toMatchObject({
      reason: 'failed',
    });
    expect(close).toHaveBeenCalledOnce();
    expect(microphone.stop).toHaveBeenCalledOnce();
    expect(shared.stop).toHaveBeenCalledOnce();
  });
});
