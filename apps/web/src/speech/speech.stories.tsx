import type { Transcription } from '@nix/api-client';
import type { ReactElement } from 'react';

import { TranscriptionPanelView, type TranscriptionPanelViewProps } from './transcription-panel';

export default { title: 'Nix/Speech', parameters: { layout: 'centered' } };

const noop = (): void => undefined;

function transcription(patch: Partial<Transcription>): Transcription {
  return {
    audioItemId: 'b1000000-0000-4000-8000-000000000001',
    noteItemId: 'a1000000-0000-4000-8000-000000000001',
    status: 'running',
    progress: 0,
    speakers: 'channels',
    operationId: 'c1000000-0000-4000-8000-000000000001',
    errorCode: null,
    createdAt: '2026-10-05T14:00:00+00:00',
    completedAt: null,
    ...patch,
  };
}

function panel(overrides: Partial<TranscriptionPanelViewProps>): ReactElement {
  return (
    <TranscriptionPanelView
      view={{ phase: 'none' }}
      available
      starting={false}
      refusal={null}
      now={Date.parse('2026-10-05T14:00:30+00:00')}
      onStart={noop}
      onCheckAgain={noop}
      {...overrides}
    />
  );
}

export function NotTranscribed(): ReactElement {
  return panel({});
}

export function Starting(): ReactElement {
  return panel({ starting: true });
}

export function Queued(): ReactElement {
  return panel({ view: { phase: 'known', transcription: transcription({ status: 'queued' }) } });
}

export function Transcribing(): ReactElement {
  return panel({
    view: { phase: 'known', transcription: transcription({ status: 'running', progress: 42 }) },
  });
}

export function Transcribed(): ReactElement {
  return panel({
    view: { phase: 'known', transcription: transcription({ status: 'completed', progress: 100 }) },
  });
}

export function Failed(): ReactElement {
  return panel({
    view: {
      phase: 'known',
      transcription: transcription({ status: 'failed', errorCode: 'transcribe.no_audio' }),
    },
  });
}

export function CannotStart(): ReactElement {
  return panel({
    refusal:
      'Only an audio file that sits under a note can be transcribed: the transcript is written into that note.',
  });
}

export function StateUnknown(): ReactElement {
  return panel({ view: { phase: 'unknown' } });
}

export function QueuedTooLong(): ReactElement {
  return panel({
    view: { phase: 'known', transcription: transcription({ status: 'queued' }) },
    now: Date.parse('2026-10-05T14:10:00+00:00'),
  });
}

export function Cancelled(): ReactElement {
  return panel({ view: { phase: 'known', transcription: transcription({ status: 'cancelled' }) } });
}

export function NotAvailableOnThisServer(): ReactElement {
  return panel({ available: false });
}
