import { isNixApiError, speech, type NixClient, type SpeechPurpose } from '@nix/api-client';
import { z } from 'zod';

/**
 * The browser's side of the speech worker (ADR-0059).
 *
 * Two hops, and the reason for each: Core issues a short-lived capability for one purpose, and
 * the worker - reached directly under /speech, so audio never passes through Core - is handed it
 * as a bearer token and asks Core whose it is. A capability is kept until shortly before it
 * expires, so reading a long note aloud is one question to Core and not one per passage.
 */

export type SpeechFailure =
  'unavailable' | 'busy' | 'rate-limited' | 'refused' | 'invalid' | 'too-long';

export class SpeechError extends Error {
  readonly reason: SpeechFailure;

  constructor(reason: SpeechFailure, options?: ErrorOptions) {
    super(reason, options);
    this.name = 'SpeechError';
    this.reason = reason;
  }
}

const voiceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  gender: z.string(),
  accent: z.string(),
});
export type SpeechVoice = z.infer<typeof voiceSchema>;

const statusSchema = z.object({
  voices: z.array(voiceSchema),
  dictation: z.boolean(),
  /** Whether recordings are being transcribed at all; a worker that answers has the recogniser. */
  transcription: z.boolean().default(false),
});
export type SpeechStatus = z.infer<typeof statusSchema>;

const dictationSchema = z.object({ text: z.string() });

interface Held {
  readonly token: string;
  readonly expiresAt: number;
}

/** Asked for again this long before it expires, so a request never leaves with a dying token. */
const RENEW_BEFORE_MS = 30_000;
const held = new Map<SpeechPurpose, Held>();

/** Forgets every capability. For signing out: the next person's requests must be their own. */
export function clearSpeechCapabilities(): void {
  held.clear();
}

async function capability(client: NixClient, purpose: SpeechPurpose): Promise<string> {
  const current = held.get(purpose);
  if (current !== undefined && current.expiresAt - Date.now() > RENEW_BEFORE_MS) {
    return current.token;
  }
  let issued;
  try {
    issued = await client.execute(speech.createCapability(purpose));
  } catch (error) {
    // Core saying "not you" is a refusal; anything else is speech being out of reach.
    const refused = isNixApiError(error) && (error.status === 401 || error.status === 403);
    throw new SpeechError(refused ? 'refused' : 'unavailable', { cause: error });
  }
  held.set(purpose, { token: issued.token, expiresAt: Date.parse(issued.expiresAt) });
  return issued.token;
}

function failureFor(status: number, code: string): SpeechFailure {
  if (status === 429) return 'rate-limited';
  if (status === 413) return 'too-long';
  if (status === 400) return 'invalid';
  if (status === 401 || status === 403) return 'refused';
  if (code === 'speech.busy') return 'busy';
  return 'unavailable';
}

async function send(
  client: NixClient,
  purpose: SpeechPurpose,
  path: string,
  init: RequestInit,
  retried = false,
): Promise<Response> {
  const token = await capability(client, purpose);
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${token}`,
      },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new SpeechError('unavailable');
  }
  if (response.ok) return response;
  // A capability the worker no longer accepts is asked for once more before giving up: it may
  // simply have expired between being read here and being checked there.
  if ((response.status === 401 || response.status === 403) && !retried) {
    held.delete(purpose);
    return send(client, purpose, path, init, true);
  }
  let code = '';
  try {
    const body: unknown = await response.json();
    if (
      typeof body === 'object' &&
      body !== null &&
      'code' in body &&
      typeof body.code === 'string'
    )
      code = body.code;
  } catch {
    // An edge or proxy error page has no code; the status is all there is.
  }
  throw new SpeechError(failureFor(response.status, code));
}

/** What the speech worker offers right now. Throws `unavailable` when it is not deployed. */
export async function fetchSpeechStatus(
  client: NixClient,
  signal?: AbortSignal,
): Promise<SpeechStatus> {
  const response = await send(client, 'synthesize', '/speech/v1/voices', {
    signal: signal ?? null,
  });
  const parsed = statusSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new SpeechError('unavailable');
  return parsed.data;
}

/** One passage of speech, as audio the browser can play. */
export async function synthesize(
  client: NixClient,
  voice: string,
  text: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const response = await send(client, 'synthesize', '/speech/v1/synthesize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voice, text }),
    signal: signal ?? null,
  });
  const audio = await response.blob();
  if (audio.size === 0) throw new SpeechError('unavailable');
  return audio;
}

/** The words in a short recorded clip. Empty when nothing was said. */
export async function dictate(
  client: NixClient,
  clip: Blob,
  hint: string,
  signal?: AbortSignal,
): Promise<string> {
  // In a header, percent-encoded, and never in the address: the hint is made of workspace
  // titles, and addresses are the first thing a proxy's log keeps.
  const response = await send(client, 'dictate', '/speech/v1/dictate', {
    method: 'POST',
    headers: {
      'Content-Type': clip.type === '' ? 'application/octet-stream' : clip.type,
      ...(hint === '' ? {} : { 'X-Nix-Speech-Hint': encodeURIComponent(hint) }),
    },
    body: clip,
    signal: signal ?? null,
  });
  const parsed = dictationSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new SpeechError('unavailable');
  return parsed.data.text.trim();
}
