import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FinishedRecording, RecorderState } from '../../recording/recorder-store';
import { RecordingBar } from '../../recording/recording-bar';
import type * as SaveRecording from '../../recording/save-recording';

const WORKSPACE = '00000000-0000-4000-8000-000000000001';
const OWNER = 'tenant:ada';
const NOTE = 'a1000000-0000-4000-8000-000000000001';
const AUDIO = 'b1000000-0000-4000-8000-000000000001';

const recorder = vi.hoisted(() => ({
  state: null as unknown as RecorderState,
  stopRecording: vi.fn(),
  pauseRecording: vi.fn(),
  resumeRecording: vi.fn(),
  forgetFinishedRecording: vi.fn(),
  recoverInterruptedRecording: vi.fn(() => Promise.resolve()),
  saveRecording: vi.fn(),
  execute: vi.fn(),
  query: vi.fn(),
  transcription: true,
}));

vi.mock('../../api/api-client-provider', () => ({
  useApiClient: () => ({ execute: recorder.execute, query: recorder.query }) as unknown,
}));
vi.mock('../../speech/speech-status', () => ({
  useSpeechStatus: () => ({ voices: [], dictation: true, transcription: recorder.transcription }),
}));
vi.mock('../../recording/recorder-store', () => ({
  useRecorderState: () => recorder.state,
  stopRecording: recorder.stopRecording,
  pauseRecording: recorder.pauseRecording,
  resumeRecording: recorder.resumeRecording,
  forgetFinishedRecording: recorder.forgetFinishedRecording,
  recoverInterruptedRecording: recorder.recoverInterruptedRecording,
}));
vi.mock('../../recording/save-recording', async (original) => ({
  ...(await original<typeof SaveRecording>()),
  saveRecording: recorder.saveRecording,
}));

const IDLE: RecorderState = {
  phase: 'idle',
  sources: null,
  sharedEnded: false,
  elapsedMs: 0,
  failure: null,
  finished: null,
};

function finished(patch: Partial<FinishedRecording> = {}): FinishedRecording {
  return {
    sessionId: 'session',
    workspaceId: WORKSPACE,
    startedAt: new Date(2026, 9, 5, 14, 30).getTime(),
    durationMs: 125_000,
    blob: new Blob([new Uint8Array(8)]),
    format: { mimeType: 'audio/webm;codecs=opus', mediaType: 'audio/webm', extension: 'weba' },
    recovered: false,
    speakers: 'channels',
    limitReached: false,
    unexpected: false,
    spooled: true,
    ...patch,
  };
}

function transcription(status: string, progress: number): unknown {
  return {
    audioItemId: AUDIO,
    noteItemId: NOTE,
    status,
    progress,
    speakers: 'channels',
    operationId: 'c1000000-0000-4000-8000-000000000001',
    errorCode: null,
    createdAt: '2026-10-05T14:00:00+00:00',
    completedAt: null,
  };
}

const onSaved = vi.fn();
const onOpenItem = vi.fn();

function renderBar(workspaceId = WORKSPACE): ReturnType<typeof render> {
  return render(
    <RecordingBar
      workspaceId={workspaceId}
      principalId={OWNER}
      createNote={() => Promise.resolve({ id: NOTE, refusal: null })}
      onSaved={onSaved}
      onOpenItem={onOpenItem}
    />,
  );
}

beforeEach(() => {
  recorder.state = IDLE;
  recorder.transcription = true;
  onSaved.mockReset();
  onOpenItem.mockReset();
  recorder.stopRecording.mockReset();
  recorder.pauseRecording.mockReset();
  recorder.forgetFinishedRecording.mockReset();
  recorder.saveRecording.mockReset().mockResolvedValue({ noteId: NOTE, audioItemId: AUDIO });
  recorder.execute.mockReset().mockResolvedValue(transcription('queued', 0));
  recorder.query.mockReset().mockResolvedValue(transcription('running', 40));
  recorder.recoverInterruptedRecording.mockClear();
});

describe('the recording bar', () => {
  it('takes no room when there is no recording, and looks for this person’s interrupted one', () => {
    renderBar();

    expect(screen.queryByRole('region', { name: 'Recording' })).not.toBeInTheDocument();
    expect(recorder.recoverInterruptedRecording).toHaveBeenCalledWith(WORKSPACE, OWNER);
  });

  it('shows how long it has recorded and from what', async () => {
    recorder.state = {
      ...IDLE,
      phase: 'recording',
      sources: 'microphone-and-shared',
      elapsedMs: 65_000,
    };
    renderBar();

    expect(screen.getByText('Recording 1:05')).toBeInTheDocument();
    expect(screen.getByText('Microphone and shared audio')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Pause recording' }));
    expect(recorder.pauseRecording).toHaveBeenCalledOnce();
  });

  it('says when sharing stopped and only the microphone is left', () => {
    recorder.state = { ...IDLE, phase: 'paused', sources: 'microphone', sharedEnded: true };
    renderBar();

    expect(screen.getByText('Sharing stopped, microphone only')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume recording' })).toBeInTheDocument();
  });

  it('saves on stop, says so, and leaves the person where they are', async () => {
    const recording = finished();
    recorder.state = { ...IDLE, phase: 'recording', sources: 'microphone' };
    recorder.stopRecording.mockResolvedValue(recording);
    renderBar();

    await userEvent.click(screen.getByRole('button', { name: 'Stop and save' }));

    await vi.waitFor(() => {
      expect(onSaved).toHaveBeenCalledOnce();
    });
    expect(recorder.saveRecording).toHaveBeenCalledWith(
      expect.anything(),
      recording,
      expect.objectContaining({ noteId: null }),
    );
    expect(recorder.forgetFinishedRecording).toHaveBeenCalledOnce();
    // An upload can take a minute: the note is offered, never opened over what is being written.
    expect(onOpenItem).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByRole('button', { name: 'Open note' }));
    expect(onOpenItem).toHaveBeenCalledWith(NOTE);
  });

  it('asks for the transcript once saved, by speaker, and says how it is getting on', async () => {
    recorder.state = { ...IDLE, finished: finished() };
    renderBar();

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Recording saved. Transcribing it now.')).toBeInTheDocument();
    expect(screen.getByText('40%')).toBeInTheDocument();
    expect(recorder.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        path: `/api/v1/items/${AUDIO}/transcription`,
        body: { speakers: 'channels' },
      }),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('region', { name: 'Saved recording' })).not.toBeInTheDocument();
  });

  it('says so when the transcript could not be asked for, and how to try again', async () => {
    recorder.state = { ...IDLE, finished: finished() };
    recorder.execute.mockRejectedValue(new Error('refused'));
    renderBar();

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Recording saved, but transcription did not start. Open the recording to try again.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open recording' }));
    expect(onOpenItem).toHaveBeenCalledWith(AUDIO);
  });

  it('does not queue a transcript on a server that is not transcribing', async () => {
    recorder.transcription = false;
    recorder.state = { ...IDLE, finished: finished() };
    renderBar();

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText(/Transcription is not available on this server right now/),
    ).toBeInTheDocument();
    expect(recorder.execute).not.toHaveBeenCalled();
  });

  it('keeps a recording that failed to save, with a retry and a download, and focus on the retry', async () => {
    recorder.state = { ...IDLE, finished: finished() };
    recorder.saveRecording.mockRejectedValueOnce(new Error('The file upload failed (503).'));
    renderBar();

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The recording could not be uploaded. It is still on this device; try again or download it.',
    );
    expect(recorder.forgetFinishedRecording).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
    // The button that was pressed is gone; focus is on what the person will press next.
    expect(screen.getByRole('button', { name: 'Try again' })).toHaveFocus();

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await vi.waitFor(() => {
      expect(onSaved).toHaveBeenCalledOnce();
    });
  });

  it('does not claim a recording is on the device when storage refused it', async () => {
    recorder.state = { ...IDLE, finished: finished({ spooled: false }) };
    recorder.saveRecording.mockRejectedValueOnce(new Error('offline'));
    renderBar();

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'It is only in this tab, so keep the tab open',
    );
  });

  it('offers back an interrupted recording and says it is not saved', () => {
    recorder.state = { ...IDLE, finished: finished({ recovered: true }) };
    renderBar();

    expect(
      screen.getByText(/was interrupted after 2:05\. It is not saved yet\.$/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('raises the alarm when a recording stopped by itself', () => {
    recorder.state = { ...IDLE, finished: finished({ unexpected: true }) };
    const unexpected = renderBar();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Recording stopped unexpectedly after 2:05. It is not saved yet.',
    );
    unexpected.unmount();

    recorder.state = { ...IDLE, finished: finished({ limitReached: true }) };
    renderBar();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Recording stopped at the size limit after 2:05. It is not saved yet. Save it, then start a new recording to keep going.',
    );
  });

  it('asks before discarding, and keeps the keyboard where the question is', async () => {
    recorder.state = { ...IDLE, finished: finished() };
    renderBar();

    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(recorder.forgetFinishedRecording).not.toHaveBeenCalled();
    expect(screen.getByText('Discard it for good?')).toBeInTheDocument();
    // On the safe answer, not lost to the top of the page.
    expect(screen.getByRole('button', { name: 'Keep' })).toHaveFocus();

    await userEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(screen.queryByText('Discard it for good?')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard' })).toHaveFocus();

    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(recorder.forgetFinishedRecording).toHaveBeenCalledOnce();
  });

  it('does not take focus from somebody working elsewhere', async () => {
    recorder.state = { ...IDLE, finished: finished() };
    recorder.saveRecording.mockReturnValue(new Promise(() => undefined));
    const view = render(
      <>
        <input aria-label="Notes" />
        <RecordingBar
          workspaceId={WORKSPACE}
          principalId={OWNER}
          createNote={() => Promise.resolve({ id: NOTE, refusal: null })}
          onSaved={onSaved}
          onOpenItem={onOpenItem}
        />
      </>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await userEvent.click(screen.getByRole('textbox', { name: 'Notes' }));
    // The bar changes state while the person types in their notes.
    recorder.state = { ...IDLE, finished: finished({ unexpected: true }) };
    view.rerender(
      <>
        <input aria-label="Notes" />
        <RecordingBar
          workspaceId={WORKSPACE}
          principalId={OWNER}
          createNote={() => Promise.resolve({ id: NOTE, refusal: null })}
          onSaved={onSaved}
          onOpenItem={onOpenItem}
        />
      </>,
    );

    expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveFocus();
  });

  it('does not save another workspace’s recording into this one', () => {
    recorder.state = { ...IDLE, finished: finished() };
    renderBar('00000000-0000-4000-8000-000000000002');

    expect(screen.getByText(/from another workspace is waiting/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
  });
});
