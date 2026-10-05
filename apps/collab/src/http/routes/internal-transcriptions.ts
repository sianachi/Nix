import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { TranscriptionAppendError } from '../../transcriptions/append.ts';
import { CoreTranscriptionError } from '../../transcriptions/core.ts';
import { refreshResident, type RouteDependencies } from '../context.ts';
import { internalCaller } from '../auth.ts';
import { isUuid, stringHeader } from '../params.ts';
import { problem } from '../replies.ts';

/**
 * A transcript is a few hundred kilobytes for an hour of speech. Four mebibytes is room for the
 * longest meeting the paragraph ceilings allow in practice, and well under what an import takes.
 */
const TRANSCRIPT_REQUEST_BYTES = 4 * 1024 * 1024;

/** The speech worker's transcript append. Internal only. */
export function registerInternalTranscriptionRoutes(
  app: FastifyInstance,
  deps: RouteDependencies,
): void {
  const transcriptions = deps.transcriptions;
  if (transcriptions === undefined) {
    return;
  }

  app.post(
    '/internal/worker-executions/transcriptions/append',
    { bodyLimit: TRANSCRIPT_REQUEST_BYTES },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const jobId = stringHeader(request, 'x-nix-worker-job-id');
      const executionId = stringHeader(request, 'x-nix-worker-execution-id');
      if (
        !internalCaller(request, deps.internalSecret) ||
        jobId === null ||
        !isUuid(jobId) ||
        executionId === null
      ) {
        return problem(
          reply,
          404,
          'transcription_not_found',
          'No such transcription is available.',
        );
      }

      let result;
      try {
        result = await transcriptions.append({ jobId, executionId, body: request.body });
      } catch (error) {
        if (error instanceof CoreTranscriptionError || error instanceof TranscriptionAppendError) {
          if (error.status >= 500) {
            // The worker will retry these, and an operator needs to see that it is: which job,
            // which refusal, and what was underneath it. Never the request body - it is the
            // content of a meeting - and the errors logged here are built without it.
            request.log.warn(
              { code: error.code, status: error.status, jobId, err: error.cause },
              'A transcript append could not be completed and will be retried.',
            );
          }
          return problem(reply, error.status, error.code, error.message);
        }
        throw error;
      }

      // After the commit, so an editor with the note open sees the transcript arrive rather than
      // finding it on the next reload. A retry that changed nothing has nothing to announce.
      if (result.appended) {
        await refreshResident(request, deps, result.noteItemId);
      }

      // The note's identifier stays here: the worker never named the note and has no use for it.
      return await reply.send({ appended: result.appended, paragraphs: result.paragraphs });
    },
  );
}
