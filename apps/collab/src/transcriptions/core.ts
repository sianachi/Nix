import { internalCoreOrigin } from '../core/internal-url.ts';

/**
 * What Core says a transcription job may do: which note receives the transcript, which audio item
 * it came from, and on whose behalf the write happens.
 *
 * Every identifier here is Core's answer, never the worker's. The worker presents only its job
 * and execution; which note that job writes to is a fact Core recorded when it accepted the
 * transcription request, after checking that the requester may read the audio and write the note.
 */
export interface TranscriptionAuthorization {
  readonly tenantId: string;
  readonly principalId: string;
  readonly workspaceId: string;
  readonly noteItemId: string;
  readonly audioItemId: string;

  /** What the recording was called when Core answered. Becomes the reference's cached label. */
  readonly audioTitle: string;
  readonly canWrite: true;
}

export interface CoreTranscriptionClient {
  authorize(execution: {
    readonly jobId: string;
    readonly executionId: string;
  }): Promise<TranscriptionAuthorization>;
}

export class CoreTranscriptionError extends Error {
  public readonly status: number;
  public readonly code: string;

  public constructor(status: number, code: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'CoreTranscriptionError';
    this.status = status;
    this.code = code;
  }
}

/** The longest recording title accepted as a reference label. */
const AUDIO_TITLE_MAX = 500;

export function createCoreTranscriptionClient(input: {
  readonly coreBaseUrl: string;
  readonly internalSecret: string;
  readonly fetchImpl?: typeof fetch;
}): CoreTranscriptionClient {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const coreBaseUrl = internalCoreOrigin(input.coreBaseUrl);
  return {
    async authorize(execution) {
      let response: Response;
      try {
        // No identifier in the path: the execution names the job, and the job names the note.
        // A path the worker could fill in would be a second, weaker statement of the same fact.
        response = await fetchImpl(
          `${coreBaseUrl}/internal/worker-executions/transcriptions/authorization`,
          {
            headers: {
              'x-nix-internal-secret': input.internalSecret,
              'x-nix-worker-job-id': execution.jobId,
              'x-nix-worker-execution-id': execution.executionId,
            },
            signal: AbortSignal.timeout(10_000),
            credentials: 'omit',
            redirect: 'error',
          },
        );
      } catch (cause) {
        // The cause is kept for whoever logs this: "Core is unavailable" is the right answer to
        // the worker and no help at all to the operator deciding whether it was DNS, a refused
        // connection or the ten-second timeout.
        throw unavailable(cause);
      }
      if (!response.ok) {
        if (response.status === 409) {
          throw new CoreTranscriptionError(
            409,
            'transcription_execution_lost',
            'The transcription worker no longer owns this job lease.',
          );
        }
        if (response.status === 404) {
          throw new CoreTranscriptionError(
            404,
            'transcription_not_found',
            'No such transcription is available.',
          );
        }
        if (response.status >= 500) {
          throw unavailable(new Error(`Core answered ${String(response.status)}.`));
        }
        // Any other refusal is Core saying no, not Core being unwell: the same request will be
        // refused the same way next time. 403 rather than a gateway error, so the worker treats
        // it as final instead of retrying a job that can never be authorized.
        throw new CoreTranscriptionError(
          403,
          'transcription_authorization_refused',
          'Core refused the transcription authorization request.',
        );
      }
      let answer: unknown;
      try {
        answer = await response.json();
      } catch {
        throw invalidAuthorization();
      }
      return parseAuthorization(answer);
    },
  };
}

function parseAuthorization(value: unknown): TranscriptionAuthorization {
  if (
    !record(value) ||
    !uuid(value.tenantId) ||
    !uuid(value.principalId) ||
    !uuid(value.workspaceId) ||
    !uuid(value.noteItemId) ||
    !uuid(value.audioItemId) ||
    typeof value.audioTitle !== 'string' ||
    value.audioTitle.length > AUDIO_TITLE_MAX ||
    value.canWrite !== true
  ) {
    throw invalidAuthorization();
  }
  return {
    tenantId: value.tenantId,
    principalId: value.principalId,
    workspaceId: value.workspaceId,
    noteItemId: value.noteItemId,
    audioItemId: value.audioItemId,
    audioTitle: value.audioTitle,
    canWrite: true,
  };
}

function unavailable(cause: unknown): CoreTranscriptionError {
  return new CoreTranscriptionError(
    503,
    'transcription_core_unavailable',
    'Core could not authorize this transcription.',
    cause,
  );
}

function invalidAuthorization(): CoreTranscriptionError {
  return new CoreTranscriptionError(
    502,
    'transcription_authorization_invalid',
    'Core returned an invalid transcription authorization response.',
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
