import { z } from 'zod';

import { operationStatusSchema } from './operations.js';

/** What a speech capability may be used for; Core issues one per purpose. */
export const speechPurposeSchema = z.enum(['synthesize', 'dictate']);
export type SpeechPurpose = z.infer<typeof speechPurposeSchema>;

/**
 * A short-lived capability for the speech worker. Opaque to the browser: it is presented to the
 * worker as a bearer token, and the worker asks Core whose it is.
 */
export const speechCapabilitySchema = z.object({
  token: z.string().min(1),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type SpeechCapability = z.infer<typeof speechCapabilitySchema>;

/**
 * Whether a recording's speakers are told apart. `channels` is a recording made by Nix with the
 * microphone and the shared audio on separate channels; anything else is `none`.
 */
export const transcriptionSpeakersSchema = z.enum(['channels', 'none']);
export type TranscriptionSpeakers = z.infer<typeof transcriptionSpeakersSchema>;

/** The current transcription of one audio item. */
export const transcriptionSchema = z.object({
  audioItemId: z.uuid(),
  noteItemId: z.uuid(),
  status: operationStatusSchema,
  /** A whole percentage; 100 once the transcript is in the note. */
  progress: z.number().int().min(0).max(100),
  speakers: transcriptionSpeakersSchema,
  operationId: z.uuid(),
  errorCode: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type Transcription = z.infer<typeof transcriptionSchema>;
