import { Capacitor } from '@capacitor/core';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { z } from 'zod';
import { coreOrigin } from '../lib/core-origin';
import { browserStorage } from '../lib/browser-storage';

const profileSchema = z.object({ subject: z.string().min(1), name: z.string().min(1) });
const credentialSchema = z.object({
  origin: z.string(),
  refreshToken: z.string().min(1),
  profile: profileSchema,
  sessionExpiresAt: z.iso.datetime({ offset: true }),
});
const accessSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: z.iso.datetime({ offset: true }),
  sessionExpiresAt: z.iso.datetime({ offset: true }),
});
const startSchema = z.object({
  deviceCode: z.string().min(1),
  userCode: z.string().min(1),
  verificationUri: z.url(),
  expiresAt: z.iso.datetime({ offset: true }),
  intervalSeconds: z.number().int().min(1).max(30),
});
const pollSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({
    status: z.literal('approved'),
    ...accessSchema.shape,
    refreshToken: z.string().min(1),
    profile: profileSchema,
  }),
  z.object({ status: z.enum(['expired', 'denied']) }),
]);
const key = (): string => `nix.mobile.session:${coreOrigin()}`;
const tombstone = (): string => `nix.mobile.signed-out:${coreOrigin()}`;
async function readCredential(): Promise<z.infer<typeof credentialSchema> | null> {
  if (browserStorage()?.getItem(tombstone()) === 'true') return null;
  const stored = await SecureStorage.get(key(), false, false);
  if (stored === null) return null;
  const parsed = credentialSchema.parse(stored);
  if (parsed.origin !== coreOrigin())
    throw new Error('The saved session belongs to another Nix server.');
  return parsed;
}
async function post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(`${coreOrigin()}/auth/cli/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  });
}
function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
}
function anonymous(): Response {
  return jsonResponse({
    authenticated: false,
    configured: true,
    profile: null,
    accessToken: null,
    expiresAt: null,
    accountUrl: null,
  });
}
export async function readAppSession(init: RequestInit): Promise<Response> {
  if (!Capacitor.isNativePlatform()) return fetch('/auth/session', init);
  const credential = await readCredential();
  if (credential === null) return anonymous();
  if (Date.parse(credential.sessionExpiresAt) <= Date.now()) return anonymous();
  const response = await post(
    'token',
    { refreshToken: credential.refreshToken },
    init.signal ?? undefined,
  );
  if (!response.ok) return response;
  const access = accessSchema.parse(await response.json());
  return jsonResponse({
    authenticated: true,
    configured: true,
    profile: credential.profile,
    accessToken: access.accessToken,
    expiresAt: access.expiresAt,
    accountUrl: null,
  });
}
export async function signInNative(
  onProgress: (message: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await post('start', { clientName: 'nix-mobile' }, signal);
  if (!response.ok)
    throw new Error('Nix could not start mobile sign-in. Retry when the server is available.');
  const start = startSchema.parse(await response.json());
  const verification = new URL(start.verificationUri);
  if (
    verification.origin !== coreOrigin() ||
    verification.pathname.replace(/\/$/u, '') !== '/auth/cli' ||
    verification.username !== '' ||
    verification.password !== ''
  )
    throw new Error('Core returned an unexpected sign-in address.');
  onProgress(`Approve sign-in in your browser. Check code ${start.userCode}, then return to Nix.`);
  const { Browser } = await import('@capacitor/browser');
  await Browser.open({ url: verification.href });
  try {
    while (Date.now() < Date.parse(start.expiresAt)) {
      signal.throwIfAborted();
      const poll = await post('poll', { deviceCode: start.deviceCode }, signal);
      if (!poll.ok) throw new Error('Nix could not check sign-in approval. Start sign-in again.');
      const result = pollSchema.parse(await poll.json());
      signal.throwIfAborted();
      if (result.status === 'approved') {
        try {
          const storage = browserStorage();
          if (storage === undefined) throw new Error('The device could not save its sign-in.');
          storage.setItem(tombstone(), 'true');
          await SecureStorage.set(
            key(),
            {
              origin: coreOrigin(),
              refreshToken: result.refreshToken,
              profile: result.profile,
              sessionExpiresAt: result.sessionExpiresAt,
            },
            false,
            false,
          );
          signal.throwIfAborted();
          storage.removeItem(tombstone());
          return;
        } catch (error) {
          await post('logout', { refreshToken: result.refreshToken }).catch(() => undefined);
          throw error;
        }
      }
      if (result.status !== 'pending')
        throw new Error(
          result.status === 'denied' ? 'Sign-in was declined.' : 'Sign-in expired. Start again.',
        );
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => {
          clearTimeout(timer);
          reject(signal.reason instanceof Error ? signal.reason : new Error('Sign-in cancelled.'));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', abort);
          resolve();
        }, start.intervalSeconds * 1_000);
        signal.addEventListener('abort', abort, { once: true });
      });
    }
    throw new Error('Sign-in expired. Start again.');
  } finally {
    await Browser.close().catch(() => undefined);
  }
}
export async function signOutAppSession(): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    await fetch('/auth/logout', {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    return;
  }
  const credential = await readCredential();
  const storage = browserStorage();
  if (storage === undefined) throw new Error('The device could not close its saved session.');
  storage.setItem(tombstone(), 'true');
  await SecureStorage.remove(key(), false);
  if (credential !== null) await post('logout', { refreshToken: credential.refreshToken });
}
