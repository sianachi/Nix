import type { TranscriptionSpeakers } from '@nix/api-client';
import { Button, Text } from '@nix/ui';
import { useState, type ReactNode } from 'react';

import { useApiClient } from '../api/api-client-provider';
import { useSpeechStatus } from './speech-status';
import { useTranscription, type TranscriptionView } from './use-transcription';

const FAILURE_COPY: Readonly<Record<string, string>> = {
  'transcribe.no_audio': 'This file has no audio to transcribe.',
  'transcribe.decode_failed': 'This file could not be read as audio.',
  'transcribe.too_large': 'This recording is too large to transcribe.',
  'transcribe.timed_out': 'This recording took too long to transcribe.',
  'transcribe.note_locked':
    'The note or the recording was locked before the transcript could be added.',
  'transcribe.note_unsupported': 'The transcript could not be added to this kind of note.',
  'transcribe.note_too_large': 'The note is too large to take the transcript.',
  'transcribe.source_unavailable': 'The recording or its note was moved, locked or deleted.',
};

/** A job still queued after this long is not waiting its turn: nothing is taking turns. */
const QUEUED_TOO_LONG_MS = 3 * 60 * 1000;

export interface TranscriptionPanelViewProps {
  readonly view: TranscriptionView;
  /** Whether this server is transcribing at all right now. */
  readonly available: boolean;
  readonly starting: boolean;
  readonly refusal: string | null;
  /** The current time, passed in so a page of states is the same every time it is drawn. */
  readonly now: number;
  readonly onStart: (speakers: TranscriptionSpeakers) => void;
  readonly onCheckAgain: () => void;
}

/** The panel as a function of what it is told, so every state it has can be put on a page. */
export function TranscriptionPanelView({
  view,
  available,
  starting,
  refusal,
  now,
  onStart,
  onCheckAgain,
}: TranscriptionPanelViewProps): ReactNode {
  // Asked for once more before a transcript somebody may have corrected by hand is replaced.
  const [confirming, setConfirming] = useState(false);
  if (view.phase === 'loading') return null;
  const transcription = view.phase === 'known' ? view.transcription : null;
  const status = transcription?.status ?? null;
  const working = status === 'queued' || status === 'running';
  // A second run keeps telling speakers apart the way the first one did.
  const speakers: TranscriptionSpeakers = transcription?.speakers ?? 'none';
  const stuck =
    status === 'queued' &&
    transcription !== null &&
    now - Date.parse(transcription.createdAt) > QUEUED_TOO_LONG_MS;

  return (
    <section aria-label="Transcript" className="flex w-full max-w-md flex-col items-center gap-2">
      {status === 'queued' ? (
        <Text variant="caption" tone="muted" role="status">
          {stuck || !available
            ? 'Still waiting. The speech service may be offline; the recording is safe and will be transcribed when it is back.'
            : 'Waiting to be transcribed. It starts when the speech service is free.'}
        </Text>
      ) : null}
      {status === 'running' && transcription !== null ? (
        <>
          {/* The words are the live region and do not change; the figure sits beside them, so a
              screen reader is told once and not every few seconds. */}
          <div className="flex items-baseline gap-2">
            <Text as="span" variant="caption" tone="muted" role="status">
              Transcribing
            </Text>
            <Text as="span" variant="caption" tone="muted">
              {String(transcription.progress)}%
            </Text>
          </div>
          <div
            role="progressbar"
            aria-label="Transcription progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={transcription.progress}
            className="h-0.5 w-full bg-divider"
          >
            <div
              className="h-full bg-accent"
              style={{ width: `${String(transcription.progress)}%` }} // design-token-exempt: width encodes how far the transcription has got, a runtime proportion.
            />
          </div>
        </>
      ) : null}
      {status === 'completed' ? (
        <Text variant="caption" tone="muted" role="status">
          The transcript is in the note this recording sits under.
        </Text>
      ) : null}
      {status === 'failed' ? (
        <Text variant="caption" role="alert">
          {FAILURE_COPY[transcription?.errorCode ?? ''] ??
            'The transcription failed. You can try again.'}
        </Text>
      ) : null}
      {status === 'cancelled' ? (
        <Text variant="caption" tone="muted" role="status">
          The transcription was cancelled.
        </Text>
      ) : null}
      {refusal === null ? null : (
        <Text variant="caption" role="alert">
          {refusal}
        </Text>
      )}
      {view.phase === 'unknown' ? (
        // Not "Transcribe": one may already be running, and asking twice would queue it twice.
        <>
          <Text variant="caption" tone="muted" role="status">
            The transcription’s state could not be read.
          </Text>
          <Button variant="secondary" onClick={onCheckAgain}>
            Check again
          </Button>
        </>
      ) : working ? null : !available ? (
        <Text variant="caption" tone="muted" role="status">
          Transcription is not available on this server right now.
        </Text>
      ) : confirming ? (
        <>
          <Text variant="caption">
            Transcribe again? This replaces the Transcript section in the note, including any edits
            made to it.
          </Text>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setConfirming(false);
              }}
            >
              Keep current transcript
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirming(false);
                onStart(speakers);
              }}
            >
              Transcribe again
            </Button>
          </div>
        </>
      ) : (
        <Button
          variant="secondary"
          disabled={starting}
          onClick={() => {
            // Only a finished transcript can have been corrected; a failed one has nothing to lose.
            if (status === 'completed') setConfirming(true);
            else onStart(speakers);
          }}
        >
          {starting ? 'Starting' : status === null ? 'Transcribe' : 'Transcribe again'}
        </Button>
      )}
    </section>
  );
}

/**
 * Where a recording says whether it has been transcribed, and where one is asked for.
 *
 * It sits under the audio player and is the same for a meeting recorded in Nix and for any audio
 * file dropped under a note. The transcript itself is never shown here: it is in the note, where
 * it can be edited, searched and linked like anything else written there.
 */
export function TranscriptionPanel({ itemId }: { readonly itemId: string }): ReactNode {
  const client = useApiClient();
  const transcription = useTranscription(client, itemId);
  const speech = useSpeechStatus(client);
  // Read once per mount: "queued too long" is judged against when the panel was drawn, and a
  // poll re-renders it every few seconds anyway.
  const [now] = useState(() => Date.now());
  return (
    <TranscriptionPanelView
      view={transcription.view}
      available={speech.transcription}
      starting={transcription.starting}
      refusal={transcription.refusal}
      now={now}
      onStart={transcription.start}
      onCheckAgain={transcription.reload}
    />
  );
}
