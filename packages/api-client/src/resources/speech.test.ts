import { describe, expect, it } from 'vitest';

import { speechCapabilitySchema, transcriptionSchema } from '../schemas/speech.js';
import { createCapability, startTranscription, transcriptionByItem } from './speech.js';

const AUDIO = '6f1c2a34-5b6d-4e7f-8a90-b1c2d3e4f506';
const NOTE = '7a2d3b45-6c7e-4f80-9ba1-c2d3e4f5a617';

describe('speech endpoints', () => {
  it('asks Core for a capability by purpose', () => {
    const endpoint = createCapability('dictate');

    expect(endpoint).toMatchObject({
      method: 'POST',
      path: '/api/v1/speech/capabilities',
      body: { purpose: 'dictate' },
    });
    expect(
      speechCapabilitySchema.parse({ token: 'opaque', expiresAt: '2026-10-05T14:05:00+00:00' }),
    ).toEqual({ token: 'opaque', expiresAt: '2026-10-05T14:05:00+00:00' });
    expect(() => speechCapabilitySchema.parse({ token: '', expiresAt: 'soon' })).toThrow();
  });

  it('starts and reads a transcription under the audio item', () => {
    expect(startTranscription(AUDIO, 'channels')).toMatchObject({
      method: 'POST',
      path: `/api/v1/items/${AUDIO}/transcription`,
      body: { speakers: 'channels' },
      invalidates: [['transcriptions', AUDIO]],
    });
    expect(transcriptionByItem(AUDIO)).toMatchObject({
      path: `/api/v1/items/${AUDIO}/transcription`,
      cacheKey: ['transcriptions', AUDIO],
      staleAfterMs: 0,
    });
  });

  it('reads a transcription and refuses one that is out of range', () => {
    const running = {
      audioItemId: AUDIO,
      noteItemId: NOTE,
      status: 'running',
      progress: 42,
      speakers: 'none',
      operationId: '8b3e4c56-7d8f-4091-acb2-d3e4f5a6b728',
      errorCode: null,
      createdAt: '2026-10-05T14:00:00+00:00',
      completedAt: null,
    };

    expect(transcriptionSchema.parse(running).progress).toBe(42);
    expect(() => transcriptionSchema.parse({ ...running, progress: 101 })).toThrow();
    expect(() => transcriptionSchema.parse({ ...running, speakers: 'everyone' })).toThrow();
    expect(() => transcriptionSchema.parse({ ...running, status: 'paused' })).toThrow();
  });
});
