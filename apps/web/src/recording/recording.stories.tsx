import type { ReactElement } from 'react';

import { RecordDialogView, type RecordDialogViewProps } from './record-dialog';
import type { FinishedRecording, RecorderState } from './recorder-store';
import {
  RecordingBarView,
  SavedNoticeView,
  type RecordingBarViewProps,
  type SavedTranscription,
} from './recording-bar';

export default { title: 'Nix/Recording', parameters: { layout: 'fullscreen' } };

const noop = (): void => undefined;

const IDLE: RecorderState = {
  phase: 'idle',
  sources: null,
  sharedEnded: false,
  elapsedMs: 0,
  failure: null,
  finished: null,
};

const FINISHED: FinishedRecording = {
  sessionId: 'session',
  workspaceId: 'workspace',
  startedAt: new Date(2026, 9, 5, 14, 30).getTime(),
  durationMs: 3_725_000,
  blob: new Blob([]),
  format: { mimeType: 'audio/webm;codecs=opus', mediaType: 'audio/webm', extension: 'weba' },
  speakers: 'channels',
  recovered: false,
  limitReached: false,
  unexpected: false,
  spooled: true,
};

function bar(overrides: Partial<RecordingBarViewProps>): ReactElement {
  return (
    <RecordingBarView
      recorder={IDLE}
      elsewhere={false}
      saving={false}
      saveError={null}
      confirmingDiscard={false}
      onTogglePause={noop}
      onStop={noop}
      onSave={noop}
      onDownload={noop}
      onAskDiscard={noop}
      onKeep={noop}
      onDiscard={noop}
      {...overrides}
    />
  );
}

export function BarRecording(): ReactElement {
  return bar({
    recorder: {
      ...IDLE,
      phase: 'recording',
      sources: 'microphone-and-shared',
      elapsedMs: 754_000,
    },
  });
}

export function BarPausedAfterSharingStopped(): ReactElement {
  return bar({
    recorder: {
      ...IDLE,
      phase: 'paused',
      sources: 'microphone',
      sharedEnded: true,
      elapsedMs: 3_725_000,
    },
  });
}

export function BarSaving(): ReactElement {
  return bar({ recorder: { ...IDLE, finished: FINISHED }, saving: true });
}

export function BarInterruptedRecording(): ReactElement {
  return bar({ recorder: { ...IDLE, finished: { ...FINISHED, recovered: true } } });
}

export function BarStoppedAtTheLimit(): ReactElement {
  return bar({ recorder: { ...IDLE, finished: { ...FINISHED, limitReached: true } } });
}

export function BarSaveFailed(): ReactElement {
  return bar({
    recorder: { ...IDLE, finished: FINISHED },
    saveError: 'The file upload failed (503).',
  });
}

export function BarConfirmingDiscard(): ReactElement {
  return bar({ recorder: { ...IDLE, finished: FINISHED }, confirmingDiscard: true });
}

export function BarFromAnotherWorkspace(): ReactElement {
  return bar({ recorder: { ...IDLE, finished: FINISHED }, elsewhere: true });
}

function dialog(overrides: Partial<RecordDialogViewProps>): ReactElement {
  return (
    <RecordDialogView
      open
      microphones={[
        { deviceId: 'built-in', label: 'MacBook Pro microphone' },
        { deviceId: 'headset', label: 'USB headset' },
      ]}
      deviceId="headset"
      canShare
      shareAudio
      starting={false}
      failure={null}
      handheld={false}
      onDeviceChange={noop}
      onShareAudioChange={noop}
      onStart={noop}
      onClose={noop}
      {...overrides}
    />
  );
}

export function Setup(): ReactElement {
  return dialog({});
}

export function SetupMicrophoneOnly(): ReactElement {
  return dialog({ canShare: false, shareAudio: false, deviceId: '' });
}

export function SetupStarting(): ReactElement {
  return dialog({ starting: true });
}

export function SetupMicrophoneDenied(): ReactElement {
  return dialog({ failure: 'microphone-denied' });
}

export function SetupSharedNothingAudible(): ReactElement {
  return dialog({ failure: 'share-silent' });
}

export function BarFinishing(): ReactElement {
  return bar({ recorder: { ...IDLE, phase: 'finishing', elapsedMs: 3_725_000 } });
}

export function BarStoppedByItself(): ReactElement {
  return bar({ recorder: { ...IDLE, finished: { ...FINISHED, unexpected: true } } });
}

export function BarSaveFailedWithoutLocalCopy(): ReactElement {
  return bar({
    recorder: { ...IDLE, finished: { ...FINISHED, spooled: false } },
    saveError:
      'The recording could not be uploaded. It is only in this tab, so keep the tab open; try again or download it.',
  });
}

function saved(transcription: SavedTranscription): ReactElement {
  return (
    <SavedNoticeView
      transcription={transcription}
      onOpenNote={noop}
      onOpenRecording={noop}
      onDismiss={noop}
    />
  );
}

function watching(status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'): ReactElement {
  return saved({
    kind: 'watching',
    view: {
      phase: 'known',
      transcription: {
        audioItemId: 'b1000000-0000-4000-8000-000000000001',
        noteItemId: 'a1000000-0000-4000-8000-000000000001',
        status,
        progress: status === 'completed' ? 100 : 42,
        speakers: 'channels',
        operationId: 'c1000000-0000-4000-8000-000000000001',
        errorCode: null,
        createdAt: '2026-10-05T14:00:00+00:00',
        completedAt: null,
      },
    },
  });
}

export function SavedAndAsking(): ReactElement {
  return saved({ kind: 'asking' });
}

export function SavedAndQueued(): ReactElement {
  return watching('queued');
}

export function SavedAndTranscribing(): ReactElement {
  return watching('running');
}

export function SavedAndTranscribed(): ReactElement {
  return watching('completed');
}

export function SavedButTranscriptionFailed(): ReactElement {
  return watching('failed');
}

export function SavedButTranscriptionCancelled(): ReactElement {
  return watching('cancelled');
}

export function SavedButTranscriptionDidNotStart(): ReactElement {
  return saved({ kind: 'not-started' });
}

export function SavedWhereTranscriptionIsUnavailable(): ReactElement {
  return saved({ kind: 'unavailable' });
}

export function SetupOnAPhone(): ReactElement {
  return dialog({ handheld: true, canShare: false, shareAudio: false });
}

export function SetupSharingCancelled(): ReactElement {
  return dialog({ failure: 'share-cancelled' });
}

export function SetupNoMicrophone(): ReactElement {
  return dialog({ failure: 'microphone-missing' });
}
