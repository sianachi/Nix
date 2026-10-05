import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RecordDialog } from '../../recording/record-dialog';
import type { RecorderState } from '../../recording/recorder-store';
import { memoryStorage } from '../views/suggest/suggest-fixtures';

const WORKSPACE = '00000000-0000-4000-8000-000000000001';
const OWNER = 'tenant:ada';

const recorder = vi.hoisted(() => ({
  state: null as unknown as RecorderState,
  startRecording: vi.fn(),
  clearRecorderFailure: vi.fn(),
  cancelStartingRecording: vi.fn(),
  canShareAudio: vi.fn(() => true),
}));

vi.mock('../../recording/recorder-store', () => ({
  useRecorderState: () => recorder.state,
  startRecording: recorder.startRecording,
  clearRecorderFailure: recorder.clearRecorderFailure,
  cancelStartingRecording: recorder.cancelStartingRecording,
}));
vi.mock('../../recording/capture', () => ({
  canShareAudio: recorder.canShareAudio,
  listMicrophones: () =>
    Promise.resolve([
      { deviceId: 'built-in', label: 'MacBook microphone' },
      { deviceId: 'headset', label: 'Headset' },
    ]),
}));

const IDLE: RecorderState = {
  phase: 'idle',
  sources: null,
  sharedEnded: false,
  elapsedMs: 0,
  failure: null,
  finished: null,
};

const onClose = vi.fn();

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  recorder.state = IDLE;
  recorder.canShareAudio.mockReturnValue(true);
  recorder.startRecording.mockReset().mockResolvedValue(true);
  recorder.cancelStartingRecording.mockReset();
  onClose.mockReset();
});

describe('setting up a recording', () => {
  it('starts with the chosen microphone and tab audio, then gets out of the way', async () => {
    render(<RecordDialog open workspaceId={WORKSPACE} principalId={OWNER} onClose={onClose} />);

    await userEvent.selectOptions(
      await screen.findByRole('combobox', { name: 'Microphone' }),
      await screen.findByRole('option', { name: 'Headset' }),
    );
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Include audio from a browser tab' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Start recording' }));

    expect(recorder.startRecording).toHaveBeenCalledWith({
      workspaceId: WORKSPACE,
      principalId: OWNER,
      deviceId: 'headset',
      shareAudio: true,
    });
    await vi.waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce();
    });
    expect(localStorage.getItem('nix.recording.microphone')).toBe('headset');
    expect(localStorage.getItem('nix.recording.share-audio')).toBe('true');
  });

  it('remembers the last choices on this device', async () => {
    localStorage.setItem('nix.recording.microphone', 'headset');
    localStorage.setItem('nix.recording.share-audio', 'true');
    render(<RecordDialog open workspaceId={WORKSPACE} principalId={OWNER} onClose={onClose} />);

    await screen.findByRole('option', { name: 'Headset' });
    expect(screen.getByRole('combobox', { name: 'Microphone' })).toHaveValue('headset');
    expect(
      screen.getByRole('checkbox', { name: 'Include audio from a browser tab' }),
    ).toBeChecked();
  });

  it('says plainly when only the microphone can be recorded', () => {
    recorder.canShareAudio.mockReturnValue(false);
    render(<RecordDialog open workspaceId={WORKSPACE} principalId={OWNER} onClose={onClose} />);

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByText(/records the microphone only/)).toBeInTheDocument();
  });

  it('explains a refusal and stays open', async () => {
    recorder.startRecording.mockResolvedValue(false);
    recorder.state = { ...IDLE, failure: 'microphone-denied' };
    render(<RecordDialog open workspaceId={WORKSPACE} principalId={OWNER} onClose={onClose} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Microphone permission was denied.');
    await userEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    expect(onClose).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(recorder.clearRecorderFailure).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls the start off when closed while the browser is still asking', async () => {
    recorder.state = { ...IDLE, phase: 'starting' };
    render(<RecordDialog open workspaceId={WORKSPACE} principalId={OWNER} onClose={onClose} />);

    expect(screen.getByRole('button', { name: 'Starting' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(recorder.cancelStartingRecording).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('says where the recording goes and how to get speakers told apart', () => {
    render(<RecordDialog open workspaceId={WORKSPACE} principalId={OWNER} onClose={onClose} />);

    expect(
      screen.getByText(/new note at the top of this workspace and transcribed/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Wear headphones/)).toBeInTheDocument();
  });

  it('reminds the person to tell the meeting', () => {
    render(<RecordDialog open workspaceId={WORKSPACE} principalId={OWNER} onClose={onClose} />);

    expect(screen.getByText(/Tell everyone in the meeting/)).toBeInTheDocument();
  });
});
