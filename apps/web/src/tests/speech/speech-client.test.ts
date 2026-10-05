import type { NixClient } from '@nix/api-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SpeechError,
  clearSpeechCapabilities,
  dictate,
  fetchSpeechStatus,
  synthesize,
} from '../../speech/speech-client';

const execute = vi.fn();
const client = { execute } as unknown as NixClient;
const fetchMock = vi.fn();

function capability(token: string, secondsLeft = 300): unknown {
  return { token, expiresAt: new Date(Date.now() + secondsLeft * 1000).toISOString() };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  clearSpeechCapabilities();
  execute.mockReset().mockResolvedValue(capability('first'));
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reaching the speech worker', () => {
  it('presents a capability for the purpose and keeps it for later requests', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(new Blob(['mp3']))));

    await synthesize(client, 'en_US-ryan-high', 'Good morning.');
    await synthesize(client, 'en_US-ryan-high', 'Again.');

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ body: { purpose: 'synthesize' } }),
    );
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/speech/v1/synthesize');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      body: JSON.stringify({ voice: 'en_US-ryan-high', text: 'Good morning.' }),
    });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer first');
  });

  it('asks for a fresh capability when one is about to expire', async () => {
    execute
      .mockResolvedValueOnce(capability('dying', 10))
      .mockResolvedValueOnce(capability('fresh'));
    fetchMock.mockImplementation(() => Promise.resolve(new Response(new Blob(['mp3']))));

    await synthesize(client, 'v', 'One.');
    await synthesize(client, 'v', 'Two.');

    expect(execute).toHaveBeenCalledTimes(2);
    const second = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((second[1].headers as Record<string, string>).Authorization).toBe('Bearer fresh');
  });

  it('retries once with a new capability when the worker refuses the old one', async () => {
    execute.mockResolvedValueOnce(capability('stale')).mockResolvedValueOnce(capability('fresh'));
    fetchMock
      .mockResolvedValueOnce(json({ code: 'speech.capability_refused' }, 403))
      .mockResolvedValueOnce(json({ voices: [], dictation: true, transcription: true }));

    expect(await fetchSpeechStatus(client)).toEqual({
      voices: [],
      dictation: true,
      transcription: true,
    });
    expect(execute).toHaveBeenCalledTimes(2);

    fetchMock.mockReset().mockResolvedValue(json({ code: 'speech.capability_refused' }, 403));
    await expect(fetchSpeechStatus(client)).rejects.toMatchObject({ reason: 'refused' });
  });

  it('keeps a capability for speaking apart from one for dictating', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(new Blob(['mp3'])))
      .mockResolvedValueOnce(json({ text: '  Remind me to call Ada.  ' }));

    await synthesize(client, 'v', 'Hello.');
    const text = await dictate(client, new Blob(['clip'], { type: 'audio/webm' }), 'Ada Lovelace');

    expect(text).toBe('Remind me to call Ada.');
    expect(execute.mock.calls.map(([endpoint]) => (endpoint as { body: unknown }).body)).toEqual([
      { purpose: 'synthesize' },
      { purpose: 'dictate' },
    ]);
    const [path, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    // The hint rides in a header: an address is what logs keep.
    expect(path).toBe('/speech/v1/dictate');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('audio/webm');
    expect((init.headers as Record<string, string>)['X-Nix-Speech-Hint']).toBe('Ada%20Lovelace');
  });

  it('says why a request failed in terms a control can act on', async () => {
    const cases: readonly [Response | Error, string][] = [
      [json({ code: 'speech.rate_limited' }, 429), 'rate-limited'],
      [json({ code: 'speech.clip_too_long' }, 413), 'too-long'],
      [json({ code: 'speech.invalid' }, 400), 'invalid'],
      [json({ code: 'speech.busy' }, 503), 'busy'],
      [json({ code: 'speech.unavailable' }, 503), 'unavailable'],
      [new Response('<html>Bad gateway</html>', { status: 502 }), 'unavailable'],
      [new TypeError('Failed to fetch'), 'unavailable'],
    ];
    for (const [answer, reason] of cases) {
      fetchMock.mockReset();
      if (answer instanceof Error) fetchMock.mockRejectedValue(answer);
      else fetchMock.mockResolvedValue(answer);
      await expect(synthesize(client, 'v', 'Hello.')).rejects.toMatchObject({ reason });
    }
  });

  it('treats Core being unable to issue a capability, or a nonsense answer, as unavailable', async () => {
    execute.mockRejectedValueOnce(new Error('offline'));
    await expect(fetchSpeechStatus(client)).rejects.toBeInstanceOf(SpeechError);

    fetchMock.mockResolvedValue(json({ voices: 'none' }));
    await expect(fetchSpeechStatus(client)).rejects.toMatchObject({ reason: 'unavailable' });

    fetchMock.mockResolvedValue(new Response(''));
    await expect(synthesize(client, 'v', 'Hello.')).rejects.toMatchObject({
      reason: 'unavailable',
    });
  });

  it('lets a cancelled request stay cancelled', async () => {
    fetchMock.mockRejectedValue(new DOMException('Aborted', 'AbortError'));

    await expect(synthesize(client, 'v', 'Hello.')).rejects.toMatchObject({ name: 'AbortError' });
  });
});
