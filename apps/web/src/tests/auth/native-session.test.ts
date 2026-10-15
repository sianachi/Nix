import { memoryStorage } from '../helpers/memory-storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock('@capacitor/browser', () => ({ Browser: { open: mocks.open, close: mocks.close } }));
vi.mock('@aparajita/capacitor-secure-storage', () => ({
  SecureStorage: {
    get: mocks.get,
    set: mocks.set,
    remove: mocks.remove,
    get then() {
      throw new Error('Native plugins cannot be awaited as Promises.');
    },
  },
}));
vi.mock('../../lib/core-origin', () => ({ coreOrigin: () => 'https://nix.example' }));
import { readAppSession, signInNative, signOutAppSession } from '../../auth/native-session';
const profile = { subject: 'core-principal', name: 'Ada' };
const access = {
  accessToken: 'short-lived-core-access',
  expiresAt: '2040-01-01T00:00:00Z',
  sessionExpiresAt: '2040-02-01T00:00:00Z',
};
const credential = {
  origin: 'https://nix.example',
  refreshToken: 'device-refresh',
  profile,
  sessionExpiresAt: access.sessionExpiresAt,
};
const challenge = {
  deviceCode: 'private-device-code',
  userCode: 'ABCDE-FGHIJ',
  verificationUri: 'https://nix.example/auth/cli?user_code=ABCDE-FGHIJ',
  expiresAt: '2040-01-01T00:00:00Z',
  intervalSeconds: 2,
};
const approved = { status: 'approved', ...access, refreshToken: credential.refreshToken, profile };
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('localStorage', memoryStorage());
  mocks.get.mockResolvedValue(credential);
  mocks.set.mockResolvedValue(undefined);
  mocks.remove.mockResolvedValue(true);
  mocks.open.mockResolvedValue(undefined);
  mocks.close.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());
describe('Capacitor browser-approved session', () => {
  it('restores only through Core, with the refresh key retained in native secure storage', async () => {
    const fetch = vi.fn().mockResolvedValue(json(access));
    vi.stubGlobal('fetch', fetch);
    const response = await readAppSession({});
    expect(await response.json()).toEqual({
      authenticated: true,
      configured: true,
      profile,
      accessToken: access.accessToken,
      expiresAt: access.expiresAt,
      accountUrl: null,
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://nix.example/auth/cli/token',
      expect.objectContaining({ body: JSON.stringify({ refreshToken: 'device-refresh' }) }),
    );
    expect(mocks.get).toHaveBeenCalledWith('nix.mobile.session:https://nix.example', false, false);
    expect(localStorage.length).toBe(0);
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it('preserves definitive session refusal and transport outage as distinct outcomes', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetch);
    expect((await readAppSession({})).status).toBe(401);
    fetch.mockRejectedValue(new TypeError('Network unavailable'));
    await expect(readAppSession({})).rejects.toThrow('Network unavailable');
  });
  it('starts anonymous when no native credential exists without sending a fake identity', async () => {
    mocks.get.mockResolvedValue(null);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await (await readAppSession({})).json()).toMatchObject({
      authenticated: false,
      profile: null,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('requires the configured Core origin for stored credentials and approval URLs', async () => {
    mocks.get.mockResolvedValue({ ...credential, origin: 'https://another.example' });
    await expect(readAppSession({})).rejects.toThrow('another Nix server');
    const fetch = vi
      .fn()
      .mockResolvedValue(
        json({ ...challenge, verificationUri: 'https://phishing.example/auth/cli' }),
      );
    vi.stubGlobal('fetch', fetch);
    await expect(signInNative(() => undefined, new AbortController().signal)).rejects.toThrow(
      'unexpected sign-in address',
    );
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it('shows the verification code, then stores only the browser-approved refresh credential', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(challenge))
      .mockResolvedValueOnce(json(approved));
    vi.stubGlobal('fetch', fetch);
    const progress = vi.fn();
    await signInNative(progress, new AbortController().signal);
    expect(progress).toHaveBeenCalledWith(expect.stringContaining(challenge.userCode));
    expect(mocks.open).toHaveBeenCalledWith({ url: challenge.verificationUri });
    expect(mocks.set).toHaveBeenCalledWith(
      'nix.mobile.session:https://nix.example',
      credential,
      false,
      false,
    );
    expect(JSON.stringify(mocks.set.mock.calls)).not.toContain(access.accessToken);
    expect(mocks.close).toHaveBeenCalled();
  });
  it('revokes an approval if secure storage fails and keeps local session admission closed', async () => {
    mocks.set.mockRejectedValue(new Error('Keychain unavailable'));
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(challenge))
      .mockResolvedValueOnce(json(approved))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    await expect(signInNative(() => undefined, new AbortController().signal)).rejects.toThrow(
      'Keychain unavailable',
    );
    expect(fetch).toHaveBeenLastCalledWith(
      'https://nix.example/auth/cli/logout',
      expect.objectContaining({ body: JSON.stringify({ refreshToken: 'device-refresh' }) }),
    );
    expect(await (await readAppSession({})).json()).toMatchObject({ authenticated: false });
  });
  it('does not restore an approval cancelled while the keychain write was finishing', async () => {
    const controller = new AbortController();
    mocks.set.mockImplementation(() => {
      controller.abort();
      return Promise.resolve();
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(challenge))
      .mockResolvedValueOnce(json(approved))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    await expect(signInNative(() => undefined, controller.signal)).rejects.toThrow();
    expect(await (await readAppSession({})).json()).toMatchObject({ authenticated: false });
  });
  it('closes saved admission before a failed network logout so relaunch stays signed out', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('Network unavailable'));
    vi.stubGlobal('fetch', fetch);
    await expect(signOutAppSession()).rejects.toThrow('Network unavailable');
    expect(mocks.remove).toHaveBeenCalledWith('nix.mobile.session:https://nix.example', false);
    expect(await (await readAppSession({})).json()).toMatchObject({ authenticated: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
