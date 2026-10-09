import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configPath, resolveProfile, saveProfile, type Profile } from '../config.ts';
import { login, logout, status } from './auth.ts';

const apiUrl = 'http://localhost:5014';
const output = { json: true, isTty: false };
const now = Date.parse('2026-10-09T12:00:00Z');
const principal = {
  id: 'p1',
  tenantId: 't1',
  displayName: 'Ada',
  email: null,
  isTenantAdministrator: true,
};
const approved = {
  status: 'approved',
  accessToken: 'ephemeral-access',
  expiresAt: '2026-10-09T12:10:00Z',
  refreshToken: 'nixcli_test-secret',
  sessionExpiresAt: '2026-10-10T12:00:00Z',
};
const start = {
  deviceCode: 'nixclidevice_test-secret',
  userCode: 'ABCD-1234',
  verificationUri: `${apiUrl}/auth/cli?user_code=ABCD-1234`,
  expiresAt: '2026-10-09T12:05:00Z',
  intervalSeconds: 2,
};
const legacy: Profile = { apiUrl, token: 'nixpat_old' };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('browser-approved CLI authentication', () => {
  let directory: string;
  let env: NodeJS.ProcessEnv;
  let stdout: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'nixctl-login-'));
    env = { XDG_CONFIG_HOME: directory };
    stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('opens browser consent, waits for approval and stores only a renewable credential', async () => {
    let clock = now;
    const fetchImpl = vi
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(json(start))
      .mockResolvedValueOnce(json({ status: 'pending' }))
      .mockResolvedValueOnce(json(approved))
      .mockResolvedValueOnce(json(principal));
    const openBrowser = vi.fn<() => Promise<void>>().mockResolvedValue();
    const writeNotice = vi.fn();
    await login({ apiUrl, profileName: 'default', makeDefault: true }, output, {
      env,
      fetchImpl,
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
      openBrowser,
      writeNotice,
    });

    expect(openBrowser).toHaveBeenCalledWith(start.verificationUri);
    expect((await resolveProfile(undefined, env))?.profile).toEqual({
      apiUrl,
      token: '',
      interactiveSession: {
        refreshToken: approved.refreshToken,
        expiresAt: approved.sessionExpiresAt,
      },
    });
    expect(JSON.parse(stdout)).toMatchObject({
      authMethod: 'browser',
      principal: { displayName: 'Ada' },
      sessionExpiresAt: approved.sessionExpiresAt,
    });
    expect(stdout).not.toContain(approved.accessToken);
    expect(stdout).not.toContain(approved.refreshToken);
    expect(stdout).not.toContain(start.deviceCode);
    expect(writeNotice.mock.calls.flat().join('')).not.toMatch(
      /nixcli_test-secret|nixclidevice_test-secret|ephemeral-access/,
    );
    expect(await readFile(configPath(env), 'utf8')).not.toContain(approved.accessToken);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('supports manual consent without opening a browser and an explicit trusted web origin', async () => {
    const verificationUri = 'http://localhost:5173/auth/cli?user_code=ABCD-1234';
    const fetchImpl = vi
      .fn<(url: string) => Promise<Response>>()
      .mockResolvedValueOnce(json({ ...start, verificationUri }))
      .mockResolvedValueOnce(json(approved))
      .mockResolvedValueOnce(json(principal));
    const openBrowser = vi.fn();
    const writeNotice = vi.fn();
    await login(
      {
        apiUrl,
        browserUrl: 'http://localhost:5173',
        browser: false,
        profileName: 'work',
        makeDefault: true,
      },
      output,
      { env, fetchImpl, now: () => now, openBrowser, writeNotice },
    );
    expect(openBrowser).not.toHaveBeenCalled();
    expect(writeNotice.mock.calls[0]?.[0]).toContain(verificationUri);
  });

  it.each([
    'http://localhost:9999/auth/cli?user_code=A',
    'https://evil.test/auth/cli?user_code=A',
    `${apiUrl}/auth/callback`,
  ])(
    'rejects an untrusted verification URL %s without changing the profile',
    async (verificationUri) => {
      await saveProfile('default', legacy, { env });
      const fetchImpl = vi.fn().mockResolvedValue(json({ ...start, verificationUri }));
      const openBrowser = vi.fn();
      await expect(
        login({ apiUrl, profileName: 'default', makeDefault: true }, output, {
          env,
          fetchImpl,
          openBrowser,
        }),
      ).rejects.toThrow(/outside the trusted origin/);
      expect(openBrowser).not.toHaveBeenCalled();
      expect((await resolveProfile('default', env))?.profile).toEqual(legacy);
    },
  );

  it.each(['denied', 'expired'])(
    'keeps the existing profile when browser approval is %s',
    async (status) => {
      await saveProfile('default', legacy, { env });
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(json(start))
        .mockResolvedValueOnce(json({ status }));
      await expect(
        login({ apiUrl, browser: false, profileName: 'default', makeDefault: true }, output, {
          env,
          fetchImpl,
          now: () => now,
          writeNotice: vi.fn(),
        }),
      ).rejects.toThrow(status === 'denied' ? /denied/ : /expired/);
      expect((await resolveProfile('default', env))?.profile).toEqual(legacy);
    },
  );

  it('revokes an approved session when saving the profile fails', async () => {
    const badDirectory = join(directory, 'file-instead-of-directory');
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(start))
      .mockResolvedValueOnce(json(approved))
      .mockImplementationOnce(async () => {
        await writeFile(badDirectory, 'occupied');
        return json(principal);
      })
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(
      login({ apiUrl, browser: false, profileName: 'default', makeDefault: true }, output, {
        env: { XDG_CONFIG_HOME: badDirectory },
        fetchImpl,
        now: () => now,
        writeNotice: vi.fn(),
      }),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenLastCalledWith(
      `${apiUrl}/auth/cli/logout`,
      expect.objectContaining({ body: JSON.stringify({ refreshToken: approved.refreshToken }) }),
    );
    expect(stdout).toBe('');
  });

  it('does not print credential-bearing transport errors', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new Error(`Failed to send ${approved.refreshToken}`));
    const failure = await login({ apiUrl, profileName: 'default', makeDefault: true }, output, {
      env,
      fetchImpl,
    }).catch((cause: unknown) => cause);
    expect(String(failure)).toContain('Core could not complete CLI authentication');
    expect(String(failure)).not.toContain(approved.refreshToken);
  });

  it('cancels a pending browser login without modifying the old profile', async () => {
    await saveProfile('default', legacy, { env });
    const controller = new AbortController();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(start))
      .mockResolvedValueOnce(json({ status: 'pending' }));
    await expect(
      login({ apiUrl, browser: false, profileName: 'default', makeDefault: true }, output, {
        env,
        fetchImpl,
        now: () => now,
        signal: controller.signal,
        writeNotice: vi.fn(),
        sleep: () => {
          controller.abort();
          return Promise.reject(new Error('CLI login was cancelled.'));
        },
      }),
    ).rejects.toThrow(/cancelled/);
    expect((await resolveProfile('default', env))?.profile).toEqual(legacy);
  });

  it('ends polling when the browser approval deadline passes', async () => {
    let clock = now;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ ...start, expiresAt: new Date(now + 1_000).toISOString() }))
      .mockResolvedValueOnce(json({ status: 'pending' }));
    await expect(
      login({ apiUrl, browser: false, profileName: 'default', makeDefault: true }, output, {
        env,
        fetchImpl,
        now: () => clock,
        writeNotice: vi.fn(),
        sleep: (ms) => {
          clock += ms;
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow(/approval expired/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await resolveProfile('default', env)).toBeNull();
  });

  it('honours bounded polling Retry-After without creating another pairing', async () => {
    let clock = now;
    const delays: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(start))
      .mockResolvedValueOnce(
        new Response('not safe to echo', { status: 429, headers: { 'retry-after': '3600' } }),
      )
      .mockResolvedValueOnce(json(approved))
      .mockResolvedValueOnce(json(principal));
    await login({ apiUrl, browser: false, profileName: 'default', makeDefault: true }, output, {
      env,
      fetchImpl,
      now: () => clock,
      writeNotice: vi.fn(),
      sleep: (ms) => {
        delays.push(ms);
        clock += ms;
        return Promise.resolve();
      },
    });
    expect(delays[0]).toBe(60_000);
    expect(fetchImpl.mock.calls.filter(([url]) => url === `${apiUrl}/auth/cli/start`)).toHaveLength(
      1,
    );
    expect(JSON.parse(stdout)).toMatchObject({ authMethod: 'browser' });
    expect(stdout).not.toContain('not safe to echo');
  });

  it('revokes the superseded interactive session after the replacement is durably saved', async () => {
    await saveProfile(
      'default',
      {
        apiUrl,
        token: '',
        interactiveSession: { refreshToken: 'nixcli_old', expiresAt: approved.sessionExpiresAt },
      },
      { env },
    );
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(start))
      .mockResolvedValueOnce(json(approved))
      .mockResolvedValueOnce(json(principal))
      .mockImplementationOnce(async () => {
        expect(
          (await resolveProfile('default', env))?.profile.interactiveSession?.refreshToken,
        ).toBe(approved.refreshToken);
        return new Response(null, { status: 204 });
      });
    await login({ apiUrl, browser: false, profileName: 'default', makeDefault: true }, output, {
      env,
      fetchImpl,
      now: () => now,
      writeNotice: vi.fn(),
    });
    expect(fetchImpl).toHaveBeenLastCalledWith(
      `${apiUrl}/auth/cli/logout`,
      expect.objectContaining({ body: JSON.stringify({ refreshToken: 'nixcli_old' }) }),
    );
  });

  it('keeps the successfully saved replacement when old-session revocation fails', async () => {
    await saveProfile(
      'default',
      {
        apiUrl,
        token: '',
        interactiveSession: { refreshToken: 'nixcli_old', expiresAt: approved.sessionExpiresAt },
      },
      { env },
    );
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(start))
      .mockResolvedValueOnce(json(approved))
      .mockResolvedValueOnce(json(principal))
      .mockResolvedValueOnce(json({}, 503));
    const writeNotice = vi.fn();
    await login({ apiUrl, browser: false, profileName: 'default', makeDefault: true }, output, {
      env,
      fetchImpl,
      now: () => now,
      writeNotice,
    });
    expect((await resolveProfile('default', env))?.profile.interactiveSession?.refreshToken).toBe(
      approved.refreshToken,
    );
    expect(writeNotice.mock.calls.flat().join('')).toContain(
      'could not confirm revocation of the previous CLI session',
    );
    expect(writeNotice.mock.calls.flat().join('')).not.toMatch(/nixcli_old|nixcli_test-secret/);
  });

  it('retains explicit PAT login without browser consent', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        json({ accessToken: 'pat-access', tokenType: 'Bearer', expiresInSeconds: 600 }),
      )
      .mockResolvedValueOnce(json(principal));
    const openBrowser = vi.fn();
    await login(
      { apiUrl, token: 'nixpat_old', profileName: 'default', makeDefault: true },
      output,
      { env, fetchImpl, openBrowser },
    );
    expect(openBrowser).not.toHaveBeenCalled();
    expect((await resolveProfile(undefined, env))?.profile).toEqual(legacy);
    expect(JSON.parse(stdout)).toMatchObject({ authMethod: 'pat' });
  });

  it('reports the authentication method without credential fields', async () => {
    const sessionExpiresAt = new Date(Date.now() + 86_400_000).toISOString();
    await saveProfile(
      'default',
      {
        apiUrl,
        token: '',
        interactiveSession: {
          refreshToken: approved.refreshToken,
          expiresAt: sessionExpiresAt,
        },
      },
      { env, makeDefault: true },
    );
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          ...approved,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          sessionExpiresAt,
        }),
      )
      .mockResolvedValueOnce(json(principal));
    await status(undefined, output, { env, fetchImpl });
    expect(JSON.parse(stdout)).toMatchObject({
      authMethod: 'browser',
      sessionExpiresAt,
    });
    expect(stdout).not.toContain(approved.refreshToken);
  });

  it('revokes a browser session before removing the profile', async () => {
    await saveProfile(
      'default',
      {
        apiUrl,
        token: '',
        interactiveSession: {
          refreshToken: approved.refreshToken,
          expiresAt: approved.sessionExpiresAt,
        },
      },
      { env },
    );
    const fetchImpl = vi.fn(async () => {
      expect(await resolveProfile('default', env)).not.toBeNull();
      return new Response(null, { status: 204 });
    });
    await logout(undefined, output, { env, fetchImpl });
    expect(await resolveProfile('default', env)).toBeNull();
    expect(stdout).toContain('revoked');
    expect(stdout).not.toContain(approved.refreshToken);
  });

  it('retains the session profile when remote logout fails', async () => {
    await saveProfile(
      'default',
      {
        apiUrl,
        token: '',
        interactiveSession: {
          refreshToken: approved.refreshToken,
          expiresAt: approved.sessionExpiresAt,
        },
      },
      { env },
    );
    const fetchImpl = vi.fn().mockResolvedValue(json({ detail: approved.refreshToken }, 503));
    await expect(logout(undefined, output, { env, fetchImpl })).rejects.toThrow(
      /profile was retained/,
    );
    expect(await resolveProfile('default', env)).not.toBeNull();
    expect(stdout).toBe('');
  });
});
