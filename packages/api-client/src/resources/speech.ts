import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import {
  speechCapabilitySchema,
  transcriptionSchema,
  type SpeechCapability,
  type SpeechPurpose,
  type Transcription,
  type TranscriptionSpeakers,
} from '../schemas/speech.js';

/**
 * Asks Core for a capability to speak or to dictate. Never cached by the client's query cache:
 * it is a credential with minutes to live, and whoever holds it decides when to ask again.
 */
export const createCapability = (purpose: SpeechPurpose): CommandEndpoint<SpeechCapability> =>
  defineCommand({
    operation: 'speech.capability.create',
    method: 'POST',
    path: '/api/v1/speech/capabilities',
    body: { purpose },
    schema: speechCapabilitySchema,
  });

/**
 * Starts transcribing an audio file into the note it sits under. Starting one that is already
 * queued or running hands back that one; starting again after it finished or failed runs it anew.
 */
export const startTranscription = (
  audioItemId: string,
  speakers: TranscriptionSpeakers,
): CommandEndpoint<Transcription> =>
  defineCommand({
    operation: 'speech.transcription.start',
    method: 'POST',
    path: `/api/v1/items/${audioItemId}/transcription`,
    body: { speakers },
    schema: transcriptionSchema,
    invalidates: [['transcriptions', audioItemId]],
  });

/** The audio item's current transcription. A 404 means none has been asked for. */
export const transcriptionByItem = (audioItemId: string): QueryEndpoint<Transcription> =>
  defineQuery({
    operation: 'speech.transcription.get',
    path: `/api/v1/items/${audioItemId}/transcription`,
    schema: transcriptionSchema,
    cacheKey: ['transcriptions', audioItemId],
    staleAfterMs: 0,
  });
