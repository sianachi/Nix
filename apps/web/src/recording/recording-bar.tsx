import { speech } from '@nix/api-client';
import { Button, Icon, Text } from '@nix/ui';
import { Mic, Pause, Play } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { announce } from '../a11y/announcer';
import { useApiClient } from '../api/api-client-provider';
import { formatClock } from '../audio/clock';
import { useSpeechStatus } from '../speech/speech-status';
import { useTranscription, type TranscriptionView } from '../speech/use-transcription';
import {
  forgetFinishedRecording,
  pauseRecording,
  recoverInterruptedRecording,
  resumeRecording,
  stopRecording,
  useRecorderState,
  type FinishedRecording,
  type RecorderState,
} from './recorder-store';
import { recordingFileName, saveFailureMessage, saveRecording } from './save-recording';

export interface RecordingBarProps {
  readonly workspaceId: string;
  /** Who is signed in, or null until that is known; an interrupted recording is theirs alone. */
  readonly principalId: string | null;
  readonly createNote: (title: string) => Promise<{ id: string | null; refusal: string | null }>;
  /** The recording is in the workspace: whatever lists its items should look again. */
  readonly onSaved: () => void;
  /** Opens the meeting's note or its recording, when the person asks to see it. */
  readonly onOpenItem: (itemId: string) => void;
}

function download(recording: FinishedRecording): void {
  const url = URL.createObjectURL(recording.blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = recordingFileName(recording.startedAt, recording.format.extension);
  link.click();
  // Revoked late: the browser reads the address after this handler returns.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);
}

/** What a recording that is waiting to be saved says about itself. Always that it is not saved. */
function waitingCopy(recording: FinishedRecording): string {
  const length = formatClock(recording.durationMs / 1000);
  if (recording.recovered) {
    const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    return `A recording from ${when.format(new Date(recording.startedAt))} was interrupted after ${length}. It is not saved yet.`;
  }
  if (recording.limitReached) {
    return `Recording stopped at the size limit after ${length}. It is not saved yet. Save it, then start a new recording to keep going.`;
  }
  if (recording.unexpected) {
    return `Recording stopped unexpectedly after ${length}. It is not saved yet.`;
  }
  return `The recording stopped after ${length}. It is not saved yet.`;
}

export interface RecordingBarViewProps {
  readonly recorder: RecorderState;
  /** The waiting recording belongs to another workspace and cannot be saved from this one. */
  readonly elsewhere: boolean;
  readonly saving: boolean;
  readonly saveError: string | null;
  readonly confirmingDiscard: boolean;
  readonly onTogglePause: () => void;
  readonly onStop: () => void;
  readonly onSave: () => void;
  readonly onDownload: () => void;
  readonly onAskDiscard: () => void;
  readonly onKeep: () => void;
  readonly onDiscard: () => void;
}

const ROW = 'flex shrink-0 items-center gap-2 border-t border-divider bg-surface px-3 py-1 sm:px-5';

type Mode = 'hidden' | 'active' | 'working' | 'waiting' | 'confirm';

/**
 * The bar as a function of what it is told, so every state it has can be put on a page.
 *
 * **Focus.** Every state replaces the controls of the one before it, so the button somebody just
 * pressed is usually gone a moment later, and focus left to itself falls to the top of the page.
 * When a change follows something done in the bar, focus is put on the new state's main control
 * (or on its status line when it has none): "Keep" at a discard confirmation, "Try again" after a
 * failed save. Focus is never taken from somebody working elsewhere.
 */
export function RecordingBarView(props: RecordingBarViewProps): ReactNode {
  const { recorder, elsewhere, saving, saveError, confirmingDiscard } = props;
  const active = recorder.phase === 'recording' || recorder.phase === 'paused';
  const waiting = recorder.finished;
  const mode: Mode = active
    ? 'active'
    : waiting === null || saving
      ? recorder.phase === 'finishing' || saving
        ? 'working'
        : 'hidden'
      : confirmingDiscard
        ? 'confirm'
        : 'waiting';

  const section = useRef<HTMLElement | null>(null);
  /** Whether the last thing the person did was in this bar, which is what earns it the focus. */
  const actedHere = useRef(false);
  const previous = useRef<Mode>(mode);
  useEffect(() => {
    const elsewhereFocused = (event: FocusEvent): void => {
      const target = event.target;
      if (target instanceof Node && target !== document.body && !section.current?.contains(target))
        actedHere.current = false;
    };
    document.addEventListener('focusin', elsewhereFocused);
    return () => {
      document.removeEventListener('focusin', elsewhereFocused);
    };
  }, []);
  useEffect(() => {
    const from = previous.current;
    previous.current = mode;
    if (!actedHere.current || mode === 'hidden') return;
    // Back from "Discard it for good?" by Keep: to the control that asked the question.
    const wanted = from === 'confirm' && mode === 'waiting' ? 'discard' : 'primary';
    section.current?.querySelector<HTMLElement>(`[data-recording-focus="${wanted}"]`)?.focus();
  }, [mode, saveError]);

  if (mode === 'hidden') return null;
  const sectionProps = {
    ref: section,
    'aria-label': 'Recording',
    onClickCapture: () => {
      actedHere.current = true;
    },
  };

  if (mode === 'active') {
    const paused = recorder.phase === 'paused';
    return (
      <section {...sectionProps} className={ROW}>
        <Icon icon={Mic} size="sm" />
        <Text as="span" variant="caption" className="whitespace-nowrap">
          {paused ? 'Paused' : 'Recording'} {formatClock(recorder.elapsedMs / 1000)}
        </Text>
        {/* Sharing that stopped is not a detail: from here on the call is heard only through
            the microphone, so it is said at full strength. */}
        <Text
          as="span"
          variant="caption"
          tone={recorder.sharedEnded ? 'default' : 'muted'}
          className="min-w-0 flex-1 truncate"
        >
          {recorder.sources === 'microphone-and-shared'
            ? 'Microphone and shared audio'
            : recorder.sharedEnded
              ? 'Sharing stopped, microphone only'
              : 'Microphone only'}
        </Text>
        <Button
          variant="icon"
          aria-label={paused ? 'Resume recording' : 'Pause recording'}
          data-recording-focus="primary"
          onClick={props.onTogglePause}
        >
          <Icon icon={paused ? Play : Pause} size="sm" />
        </Button>
        <Button variant="secondary" className="px-2 py-1 text-xs" onClick={props.onStop}>
          Stop and save
        </Button>
      </section>
    );
  }

  if (mode === 'working' || waiting === null) {
    return (
      <section {...sectionProps} className={ROW}>
        <span tabIndex={-1} data-recording-focus="primary" className="min-w-0 flex-1 outline-none">
          <Text as="span" variant="caption" role="status" className="truncate">
            {saving ? 'Saving the recording' : 'Finishing the recording'}
          </Text>
        </span>
      </section>
    );
  }

  // A recording nobody stopped is news, and the meeting may still be going on.
  const urgent = saveError !== null || waiting.unexpected || waiting.limitReached;
  return (
    <section {...sectionProps} className={`${ROW} flex-wrap`}>
      <Text
        as="span"
        variant="caption"
        role={urgent ? 'alert' : 'status'}
        className="min-w-0 flex-1"
      >
        {saveError ??
          (elsewhere
            ? 'A recording from another workspace is waiting. Switch back to that workspace to save it, or download it.'
            : waitingCopy(waiting))}
      </Text>
      {mode === 'confirm' ? (
        <>
          <Text as="span" variant="caption" tone="muted">
            Discard it for good?
          </Text>
          <Button
            variant="ghost"
            className="px-2 py-1 text-xs"
            data-recording-focus="primary"
            onClick={props.onKeep}
          >
            Keep
          </Button>
          <Button variant="secondary" className="px-2 py-1 text-xs" onClick={props.onDiscard}>
            Discard
          </Button>
        </>
      ) : (
        <>
          <Button
            variant="ghost"
            className="px-2 py-1 text-xs"
            data-recording-focus="discard"
            onClick={props.onAskDiscard}
          >
            Discard
          </Button>
          <Button
            variant="ghost"
            className="px-2 py-1 text-xs"
            data-recording-focus={elsewhere ? 'primary' : undefined}
            onClick={props.onDownload}
          >
            Download
          </Button>
          {elsewhere ? null : (
            <Button
              variant="secondary"
              className="px-2 py-1 text-xs"
              data-recording-focus="primary"
              onClick={props.onSave}
            >
              {saveError === null ? 'Save' : 'Try again'}
            </Button>
          )}
        </>
      )}
    </section>
  );
}

/** How the transcript of a recording that was just saved stands. */
export type SavedTranscription =
  | { readonly kind: 'asking' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'not-started' }
  | { readonly kind: 'watching'; readonly view: TranscriptionView };

export interface SavedNoticeViewProps {
  readonly transcription: SavedTranscription;
  readonly onOpenNote: () => void;
  readonly onOpenRecording: () => void;
  readonly onDismiss: () => void;
}

/**
 * What the bar says once a recording is in the workspace: that it is saved, how its transcript
 * is getting on, and how to get to it. The note is offered, never opened: an upload can take a
 * minute, and by then the person is back in whatever they were writing.
 */
export function SavedNoticeView({
  transcription,
  onOpenNote,
  onOpenRecording,
  onDismiss,
}: SavedNoticeViewProps): ReactNode {
  const status =
    transcription.kind === 'watching' && transcription.view.phase === 'known'
      ? transcription.view.transcription
      : null;
  const failed =
    transcription.kind === 'not-started' ||
    status?.status === 'failed' ||
    status?.status === 'cancelled';
  const copy =
    transcription.kind === 'unavailable'
      ? 'Recording saved. Transcription is not available on this server right now.'
      : transcription.kind === 'not-started'
        ? 'Recording saved, but transcription did not start. Open the recording to try again.'
        : status === null
          ? 'Recording saved.'
          : status.status === 'queued'
            ? 'Recording saved. It is waiting to be transcribed.'
            : status.status === 'running'
              ? 'Recording saved. Transcribing it now.'
              : status.status === 'completed'
                ? 'Recording saved. The transcript is in the note.'
                : status.status === 'cancelled'
                  ? 'Recording saved. The transcription was cancelled; open the recording to try again.'
                  : 'Recording saved, but it could not be transcribed. Open the recording to try again.';
  return (
    <section aria-label="Saved recording" className={`${ROW} flex-wrap`}>
      <Text
        as="span"
        variant="caption"
        role={failed ? 'alert' : 'status'}
        className="min-w-0 flex-1"
      >
        {copy}
      </Text>
      {/* Beside the words and outside the live region: read once on request, not every poll. */}
      {status?.status === 'running' ? (
        <Text as="span" variant="caption" tone="muted" className="whitespace-nowrap">
          {String(status.progress)}%
        </Text>
      ) : null}
      {failed ? (
        <Button variant="ghost" className="px-2 py-1 text-xs" onClick={onOpenRecording}>
          Open recording
        </Button>
      ) : null}
      <Button variant="ghost" className="px-2 py-1 text-xs" onClick={onOpenNote}>
        Open note
      </Button>
      <Button variant="ghost" className="px-2 py-1 text-xs" onClick={onDismiss}>
        Dismiss
      </Button>
    </section>
  );
}

interface Saved {
  readonly noteId: string;
  readonly audioItemId: string;
  readonly transcription: 'asking' | 'unavailable' | 'not-started' | 'started';
}

/** Follows the saved recording's transcription, and steps aside a little after it lands. */
function SavedNotice({
  saved,
  onOpenItem,
  onDismiss,
}: {
  readonly saved: Saved;
  readonly onOpenItem: (itemId: string) => void;
  readonly onDismiss: () => void;
}): ReactNode {
  const client = useApiClient();
  // Asked for whichever state this is in, because hooks cannot be conditional; it reads
  // "none" until a transcription exists, which is exactly the "asking" state.
  const { view } = useTranscription(client, saved.audioItemId);
  const landed = view.phase === 'known' && view.transcription.status === 'completed';
  useEffect(() => {
    if (!landed) return;
    const timer = setTimeout(onDismiss, 8000);
    return () => {
      clearTimeout(timer);
    };
  }, [landed, onDismiss]);

  const transcription: SavedTranscription =
    saved.transcription === 'started' ? { kind: 'watching', view } : { kind: saved.transcription };
  return (
    <SavedNoticeView
      transcription={transcription}
      onOpenNote={() => {
        onOpenItem(saved.noteId);
      }}
      onOpenRecording={() => {
        onOpenItem(saved.audioItemId);
      }}
      onDismiss={onDismiss}
    />
  );
}

/**
 * The recorder's face while the person is somewhere else: a row in the shell's bottom chrome that
 * exists only while there is a recording to speak of.
 *
 * It also owns what happens to a finished recording. Stopping saves straight away, because that is
 * what stopping means; a recording that ended some other way - the size limit, a lost microphone,
 * a tab that died - waits here for the person to save or discard it, and one that failed to save
 * stays with a retry and a way to download it, so an hour of meeting is never one failed request
 * from gone. Once saved, its transcript is asked for and followed from the same row.
 */
export function RecordingBar({
  workspaceId,
  principalId,
  createNote,
  onSaved,
  onOpenItem,
}: RecordingBarProps): ReactNode {
  const client = useApiClient();
  const recorder = useRecorderState();
  const speechStatus = useSpeechStatus(client);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  /** The note an earlier attempt made for this recording, so a retry does not make another. */
  const note = useRef<{ sessionId: string; noteId: string } | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);

  useEffect(() => {
    if (principalId !== null) void recoverInterruptedRecording(workspaceId, principalId);
  }, [workspaceId, principalId]);

  // Said once each, when they happen: a recording that ended by itself, and sharing that stopped.
  // Both change what is being captured while the person is looking at something else.
  const waiting = recorder.finished;
  const stoppedByItself =
    waiting !== null && (waiting.unexpected || waiting.limitReached) ? waiting.sessionId : null;
  useEffect(() => {
    if (stoppedByItself !== null)
      announce('The recording has stopped and is not saved yet. See the recording bar.');
  }, [stoppedByItself]);
  const sharingStopped = recorder.sharedEnded && recorder.phase !== 'idle';
  useEffect(() => {
    if (sharingStopped) announce('Sharing stopped. Only your microphone is being recorded.');
  }, [sharingStopped]);

  // Asked for straight after a save, and never allowed to fail it: the recording is in the
  // workspace either way, and its own page offers "Transcribe" if this did not take.
  function askForTranscript(
    noteId: string,
    audioItemId: string,
    recording: FinishedRecording,
  ): void {
    if (!speechStatus.transcription) {
      setSaved({ noteId, audioItemId, transcription: 'unavailable' });
      return;
    }
    setSaved({ noteId, audioItemId, transcription: 'asking' });
    void Promise.resolve()
      .then(() => client.execute(speech.startTranscription(audioItemId, recording.speakers)))
      .then(
        () => {
          setSaved({ noteId, audioItemId, transcription: 'started' });
        },
        () => {
          setSaved({ noteId, audioItemId, transcription: 'not-started' });
        },
      );
  }

  async function save(recording: FinishedRecording): Promise<void> {
    setSaving(true);
    setSaveError(null);
    setConfirmingDiscard(false);
    try {
      const result = await saveRecording(client, recording, {
        noteId: note.current?.sessionId === recording.sessionId ? note.current.noteId : null,
        createNote,
        onNoteCreated: (created) => {
          note.current = { sessionId: recording.sessionId, noteId: created };
        },
      });
      note.current = null;
      forgetFinishedRecording();
      announce('Recording saved.');
      onSaved();
      askForTranscript(result.noteId, result.audioItemId, recording);
    } catch (error) {
      // Where the recording is, said truthfully: storage that refused it is not "this device".
      const kept = recording.spooled
        ? 'It is still on this device; try again or download it.'
        : 'It is only in this tab, so keep the tab open; try again or download it.';
      const message = `${saveFailureMessage(error)} ${kept}`;
      setSaveError(message);
      announce(message);
    } finally {
      setSaving(false);
    }
  }

  const dismissSaved = useCallback(() => {
    setSaved(null);
  }, []);

  // The note is made through this workspace's tree, so a recording begun in another one cannot be
  // saved from here; it can still be downloaded or let go.
  const elsewhere = waiting !== null && waiting.workspaceId !== workspaceId;

  return (
    <>
      {saved === null ? null : (
        <SavedNotice
          key={saved.audioItemId}
          saved={saved}
          onOpenItem={onOpenItem}
          onDismiss={dismissSaved}
        />
      )}
      <RecordingBarView
        recorder={recorder}
        elsewhere={elsewhere}
        saving={saving}
        saveError={saveError}
        confirmingDiscard={confirmingDiscard}
        onTogglePause={() => {
          const paused = recorder.phase === 'paused';
          if (paused) resumeRecording();
          else pauseRecording();
          announce(paused ? 'Recording resumed.' : 'Recording paused.');
        }}
        onStop={() => {
          void stopRecording().then((recording) => {
            if (recording === null) announce('Nothing was recorded.');
            else if (recording.workspaceId === workspaceId) void save(recording);
          });
        }}
        onSave={() => {
          if (waiting !== null && !elsewhere) void save(waiting);
        }}
        onDownload={() => {
          if (waiting !== null) download(waiting);
        }}
        onAskDiscard={() => {
          setConfirmingDiscard(true);
        }}
        onKeep={() => {
          setConfirmingDiscard(false);
        }}
        onDiscard={() => {
          // A failed upload leaves the note that was made for it; say so rather than hide it.
          const orphaned = note.current !== null;
          note.current = null;
          setSaveError(null);
          setConfirmingDiscard(false);
          forgetFinishedRecording();
          announce(
            orphaned
              ? 'Recording discarded. The empty note made for it is still in the workspace.'
              : 'Recording discarded.',
          );
        }}
      />
    </>
  );
}
