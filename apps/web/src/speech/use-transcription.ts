import {
  isNixApiError,
  speech,
  type NixClient,
  type Transcription,
  type TranscriptionSpeakers,
} from '@nix/api-client';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * One recording's transcription, as a component sees it.
 *
 * `none` is "nobody has asked", which is where every ordinary audio file starts and is not a
 * failure. While a transcription is queued or running the answer is asked for again every few
 * seconds, because it is somebody else's process that moves it; once it has finished, failed or
 * been cancelled there is nothing left to watch.
 *
 * The state belongs to one audio item. A caller showing a different item mounts this afresh (a
 * `key` on the component), so nothing here has to be reset when the item changes.
 */
export type TranscriptionView =
  | { readonly phase: 'loading' }
  | { readonly phase: 'none' }
  | { readonly phase: 'unknown' }
  | { readonly phase: 'known'; readonly transcription: Transcription };

const POLL_MS = 3000;

const REFUSAL_COPY: Readonly<Record<string, string>> = {
  'transcriptions.unsupported':
    'Only an audio file that sits under a note can be transcribed: the transcript is written into that note.',
  'transcriptions.locked': 'Unlock the note and the recording to transcribe it.',
  'transcriptions.not_found':
    'This recording cannot be transcribed by you: it, or the note it sits under, is not yours to change.',
  'transcriptions.storage_not_configured': 'File storage is not set up on this server.',
};

export function transcriptionRefusal(error: unknown): string {
  if (isNixApiError(error)) {
    return REFUSAL_COPY[error.code] ?? error.detail ?? 'The transcription could not be started.';
  }
  return 'The transcription could not be started.';
}

function active(view: TranscriptionView): boolean {
  return (
    view.phase === 'known' &&
    (view.transcription.status === 'queued' || view.transcription.status === 'running')
  );
}

/** The item's transcription as it stands, or null when the question was abandoned. */
async function readView(
  client: NixClient,
  audioItemId: string,
  signal: AbortSignal,
): Promise<TranscriptionView | null> {
  try {
    const transcription = await client.query(speech.transcriptionByItem(audioItemId), {
      signal,
      forceRefresh: true,
    });
    return signal.aborted ? null : { phase: 'known', transcription };
  } catch (error) {
    if (signal.aborted) return null;
    return isNixApiError(error) && error.status === 404 ? { phase: 'none' } : { phase: 'unknown' };
  }
}

export function useTranscription(
  client: NixClient,
  audioItemId: string,
): {
  readonly view: TranscriptionView;
  readonly starting: boolean;
  readonly refusal: string | null;
  readonly start: (speakers: TranscriptionSpeakers) => void;
  /** Asks again, for when the first answer could not be read. */
  readonly reload: () => void;
} {
  const [view, setView] = useState<TranscriptionView>({ phase: 'loading' });
  const [starting, setStarting] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  /** Which item the state above describes, so an answer about another one is dropped. */
  const current = useRef(audioItemId);

  useEffect(() => {
    current.current = audioItemId;
    const controller = new AbortController();
    void readView(client, audioItemId, controller.signal).then((next) => {
      if (next !== null) setView(next);
    });
    return () => {
      controller.abort();
    };
  }, [client, audioItemId]);

  const watching = active(view);
  useEffect(() => {
    if (!watching) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      void readView(client, audioItemId, controller.signal).then((next) => {
        // One poll that could not be read is a blip, not news: what was known still stands, and
        // the next poll asks again. Forgetting it here would offer "Transcribe" on a job that
        // is running.
        if (next !== null && next.phase !== 'unknown') setView(next);
      });
    }, POLL_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [watching, client, audioItemId]);

  // Stable, because the panel hands it to a button whose owner may be memoised by its caller and
  // because `reload` and the effects above are keyed on the same two values.
  const start = useCallback(
    (speakers: TranscriptionSpeakers): void => {
      setStarting(true);
      setRefusal(null);
      void client
        .execute(speech.startTranscription(audioItemId, speakers))
        .then(
          (transcription) => {
            if (current.current === audioItemId) setView({ phase: 'known', transcription });
          },
          (error: unknown) => {
            if (current.current === audioItemId) setRefusal(transcriptionRefusal(error));
          },
        )
        .finally(() => {
          setStarting(false);
        });
    },
    [client, audioItemId],
  );

  const reload = (): void => {
    void readView(client, audioItemId, new AbortController().signal).then((next) => {
      if (next !== null && current.current === audioItemId) setView(next);
    });
  };

  return { view, starting, refusal, start, reload };
}
