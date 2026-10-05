import { NixApiError } from '@nix/api-client';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TranscriptionPanel } from '../../speech/transcription-panel';

const AUDIO = 'b1000000-0000-4000-8000-000000000001';
const client = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn(), transcription: true }));
vi.mock('../../api/api-client-provider', () => ({ useApiClient: () => client as unknown }));
vi.mock('../../speech/speech-status', () => ({
  useSpeechStatus: () => ({ voices: [], dictation: true, transcription: client.transcription }),
}));

function transcription(status: string, patch: Record<string, unknown> = {}): unknown {
  return {
    audioItemId: AUDIO,
    noteItemId: 'a1000000-0000-4000-8000-000000000001',
    status,
    progress: 0,
    speakers: 'channels',
    operationId: 'c1000000-0000-4000-8000-000000000001',
    errorCode: null,
    createdAt: '2026-10-05T14:00:00+00:00',
    completedAt: null,
    ...patch,
  };
}

function refusal(status: number, code: string): NixApiError {
  return new NixApiError({ kind: 'http', code, status, message: code });
}

beforeEach(() => {
  client.query.mockReset();
  client.execute.mockReset();
  client.transcription = true;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a recording’s transcript', () => {
  it('offers to transcribe an audio file nobody has transcribed', async () => {
    client.query.mockRejectedValue(refusal(404, 'transcriptions.not_found'));
    client.execute.mockResolvedValue(
      transcription('queued', { createdAt: new Date().toISOString() }),
    );
    render(<TranscriptionPanel itemId={AUDIO} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Transcribe' }));

    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        path: `/api/v1/items/${AUDIO}/transcription`,
        body: { speakers: 'none' },
      }),
    );
    expect(await screen.findByText(/Waiting to be transcribed/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('follows a running transcription until it lands', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    client.query
      .mockResolvedValueOnce(transcription('running', { progress: 40 }))
      .mockResolvedValue(transcription('completed', { progress: 100 }));
    render(<TranscriptionPanel itemId={AUDIO} />);

    expect(await screen.findByText('Transcribing')).toBeInTheDocument();
    // The figure is beside the live words, not in them: it is read once, not every poll.
    expect(screen.getByRole('status')).toHaveTextContent(/^Transcribing$/);
    expect(screen.getByText('40%')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Transcription progress' })).toHaveAttribute(
      'aria-valuenow',
      '40',
    );

    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
    });

    expect(await screen.findByText(/The transcript is in the note/)).toBeInTheDocument();
    // Nothing is left to watch, so nothing more is asked.
    const asked = client.query.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(9000);
    });
    expect(client.query).toHaveBeenCalledTimes(asked);
  });

  it('transcribes again the way the recording was first transcribed', async () => {
    client.query.mockResolvedValue(transcription('completed', { progress: 100 }));
    client.execute.mockResolvedValue(transcription('queued'));
    render(<TranscriptionPanel itemId={AUDIO} />);

    // A finished transcript may have been corrected by hand, so replacing it is asked about.
    await userEvent.click(await screen.findByRole('button', { name: 'Transcribe again' }));
    expect(client.execute).not.toHaveBeenCalled();
    expect(screen.getByText(/including any edits made to it/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Keep current transcript' }));
    expect(client.execute).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Transcribe again' }));
    await userEvent.click(screen.getByRole('button', { name: 'Transcribe again' }));
    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({ body: { speakers: 'channels' } }),
    );
  });

  it('says why a transcription failed and why one cannot start', async () => {
    client.query.mockResolvedValue(transcription('failed', { errorCode: 'transcribe.no_audio' }));
    client.execute.mockRejectedValue(refusal(409, 'transcriptions.unsupported'));
    render(<TranscriptionPanel itemId={AUDIO} />);

    expect(await screen.findByText('This file has no audio to transcribe.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Transcribe again' }));

    expect(await screen.findByText(/sits under a note can be transcribed/)).toBeInTheDocument();
  });

  it('admits when it cannot tell, and offers to look again rather than to start another', async () => {
    client.query
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(transcription('running', { progress: 10 }));
    render(<TranscriptionPanel itemId={AUDIO} />);

    expect(await screen.findByText(/state could not be read/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Transcribe' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('Transcribing')).toBeInTheDocument();
  });

  it('keeps watching through a poll that could not be read', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    client.query
      .mockResolvedValueOnce(transcription('running', { progress: 40 }))
      .mockRejectedValueOnce(new Error('a blip'))
      .mockResolvedValue(transcription('completed', { progress: 100 }));
    render(<TranscriptionPanel itemId={AUDIO} />);
    expect(await screen.findByText('Transcribing')).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
    });
    // Still running as far as anybody knows, and no button to start it twice.
    expect(screen.getByText('Transcribing')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
    });
    expect(await screen.findByText(/The transcript is in the note/)).toBeInTheDocument();
  });

  it('stops calling a long wait a queue', async () => {
    // Queued since long before this panel was drawn: nothing is taking turns.
    client.query.mockResolvedValue(transcription('queued'));
    render(<TranscriptionPanel itemId={AUDIO} />);

    expect(
      await screen.findByText(/Still waiting\. The speech service may be offline/),
    ).toBeInTheDocument();
  });

  it('says plainly when this server is not transcribing', async () => {
    client.transcription = false;
    client.query.mockRejectedValue(refusal(404, 'transcriptions.not_found'));
    render(<TranscriptionPanel itemId={AUDIO} />);

    expect(
      await screen.findByText('Transcription is not available on this server right now.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
