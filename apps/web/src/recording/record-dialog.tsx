import { Button, Checkbox, Dialog, Field, Select, Text } from '@nix/ui';
import { useEffect, useState, type ReactNode } from 'react';

import { announce } from '../a11y/announcer';
import { canShareAudio, listMicrophones, type CaptureFailure, type Microphone } from './capture';
import {
  cancelStartingRecording,
  clearRecorderFailure,
  startRecording,
  useRecorderState,
} from './recorder-store';
import {
  readPreferredMicrophone,
  readShareAudioPreference,
  writePreferredMicrophone,
  writeShareAudioPreference,
} from './recording-preferences';

const FAILURE_COPY: Readonly<Record<CaptureFailure, string>> = {
  unsupported: 'This browser cannot record audio.',
  'microphone-denied':
    'Microphone permission was denied. Allow it in browser settings, then try again.',
  'microphone-missing': 'No microphone was found. Connect one and try again.',
  'share-cancelled':
    'Nothing was shared. Choose the meeting’s tab to include its audio, or untick that option.',
  'share-silent':
    'What you shared has no audio. Choose a browser tab with its audio switched on. If your browser does not offer that, untick this option to record the microphone only.',
  failed: 'The recording could not start. Try again.',
};

const DEFAULT_MICROPHONE = '';

export interface RecordDialogViewProps {
  readonly open: boolean;
  readonly microphones: readonly Microphone[];
  /** The chosen device id, or the empty string for the system default. */
  readonly deviceId: string;
  /** Whether this browser can share a tab's audio at all. */
  readonly canShare: boolean;
  readonly shareAudio: boolean;
  readonly starting: boolean;
  readonly failure: CaptureFailure | null;
  /** A phone or tablet, where the browser may stop capturing when the page is left. */
  readonly handheld: boolean;
  readonly onDeviceChange: (deviceId: string) => void;
  readonly onShareAudioChange: (share: boolean) => void;
  readonly onStart: () => void;
  readonly onClose: () => void;
}

/** The dialog as a function of what it is told, so every state it has can be put on a page. */
export function RecordDialogView(props: RecordDialogViewProps): ReactNode {
  const { microphones, deviceId, starting } = props;
  // A remembered microphone that is not plugged in today is shown as the default, which is what
  // the recorder will fall back to.
  const selected = microphones.some((entry) => entry.deviceId === deviceId)
    ? deviceId
    : DEFAULT_MICROPHONE;

  return (
    <Dialog
      open={props.open}
      title="Record a meeting"
      onClose={props.onClose}
      actions={
        <>
          <Button variant="secondary" onClick={props.onClose}>
            Cancel
          </Button>
          <Button disabled={starting} onClick={props.onStart}>
            {starting ? 'Starting' : 'Start recording'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Microphone">
          {(control) => (
            <Select
              {...control}
              value={selected}
              disabled={starting}
              onChange={(event) => {
                props.onDeviceChange(event.currentTarget.value);
              }}
            >
              <option value={DEFAULT_MICROPHONE}>System default</option>
              {microphones.map((entry) => (
                <option key={entry.deviceId} value={entry.deviceId}>
                  {entry.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {props.canShare ? (
          <div className="flex flex-col gap-1">
            <Checkbox
              label="Include audio from a browser tab"
              checked={props.shareAudio}
              disabled={starting}
              onChange={(event) => {
                props.onShareAudioChange(event.currentTarget.checked);
              }}
            />
            <Text variant="caption" tone="muted">
              For online meetings. Your browser will ask what to share: choose the meeting’s tab and
              keep its audio switched on. Wear headphones, so the transcript can tell your voice
              from the call’s.
            </Text>
          </div>
        ) : (
          <Text variant="caption" tone="muted">
            This browser records the microphone only, so people on a call are heard only through
            your speakers.
          </Text>
        )}
        <Text variant="caption" tone="muted">
          Tell everyone in the meeting that it is being recorded. When you stop, it is saved as a
          new note at the top of this workspace and transcribed into that note.
        </Text>
        {props.handheld ? (
          <Text variant="caption" tone="muted">
            Keep this page open and on screen while recording. A phone may pause the recording when
            you switch apps or lock the screen.
          </Text>
        ) : null}
        {props.failure === null ? null : (
          <Text role="alert" variant="caption">
            {FAILURE_COPY[props.failure]}
          </Text>
        )}
      </div>
    </Dialog>
  );
}

export interface RecordDialogProps {
  readonly open: boolean;
  readonly workspaceId: string;
  /** Whose recording this will be; an interrupted one is offered back only to them. */
  readonly principalId: string;
  readonly onClose: () => void;
}

/**
 * Where a recording is set up: which microphone, and whether a tab's audio comes with it.
 *
 * It closes the moment recording starts, because from then on the bar in the shell is the
 * recorder's face and the person should be back in their notes.
 */
export function RecordDialog({
  open,
  workspaceId,
  principalId,
  onClose,
}: RecordDialogProps): ReactNode {
  const recorder = useRecorderState();
  const [microphones, setMicrophones] = useState<readonly Microphone[]>([]);
  const [deviceId, setDeviceId] = useState(() => readPreferredMicrophone() ?? DEFAULT_MICROPHONE);
  const [shareAudio, setShareAudio] = useState(() => canShareAudio() && readShareAudioPreference());

  useEffect(() => {
    if (!open) return;
    let current = true;
    void listMicrophones()
      .catch(() => [])
      .then((found) => {
        if (current) setMicrophones(found);
      });
    return () => {
      current = false;
    };
  }, [open]);

  async function start(): Promise<void> {
    const chosen = deviceId === DEFAULT_MICROPHONE ? null : deviceId;
    const started = await startRecording({
      workspaceId,
      principalId,
      deviceId: chosen,
      shareAudio,
    });
    if (!started) return;
    writePreferredMicrophone(chosen);
    writeShareAudioPreference(shareAudio);
    announce('Recording started.');
    onClose();
  }

  return (
    <RecordDialogView
      open={open}
      microphones={microphones}
      deviceId={deviceId}
      canShare={canShareAudio()}
      shareAudio={shareAudio}
      starting={recorder.phase === 'starting'}
      failure={recorder.failure}
      handheld={
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(pointer: coarse)').matches
      }
      onDeviceChange={setDeviceId}
      onShareAudioChange={setShareAudio}
      onStart={() => {
        void start();
      }}
      onClose={() => {
        // Closing while the browser's prompts are still up is "no": whatever is answered in them
        // afterwards, nothing is recorded.
        cancelStartingRecording();
        clearRecorderFailure();
        onClose();
      }}
    />
  );
}
