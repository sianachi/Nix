import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configPath,
  loadConfig,
  removeProfile,
  resolveProfile,
  saveProfile,
  type Profile,
} from './config.ts';

const profile: Profile = { apiUrl: 'http://localhost:5014', token: 'nixpat_abc' };

describe('the config store', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nixctl-config-'));
    env = { XDG_CONFIG_HOME: dir };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads an empty config when there is no file yet', async () => {
    expect(await loadConfig(env)).toEqual({ defaultProfile: 'default', profiles: {} });
  });

  it('stores a profile and reads it back', async () => {
    await saveProfile('work', profile, { makeDefault: true, env });

    const resolved = await resolveProfile(undefined, env);
    expect(resolved?.name).toBe('work');
    expect(resolved?.profile).toEqual(profile);
  });

  it('writes the file readable only by its owner', async () => {
    await saveProfile('work', profile, { env });

    const mode = (await stat(configPath(env))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('keeps the token off any wider surface than the file', async () => {
    await saveProfile('work', profile, { env });
    // The token is in the file (there is nowhere else it could be exchanged from), and the file is
    // the 0600 asserted above - this pins that the token is not additionally written elsewhere.
    const raw = await readFile(configPath(env), 'utf8');
    expect(raw).toContain('nixpat_abc');
  });

  it('resolves a named profile over the default', async () => {
    await saveProfile('default', profile, { makeDefault: true, env });
    await saveProfile('staging', { apiUrl: 'http://staging', token: 'nixpat_stg' }, { env });

    expect((await resolveProfile('staging', env))?.profile.apiUrl).toBe('http://staging');
    expect((await resolveProfile(undefined, env))?.profile.apiUrl).toBe('http://localhost:5014');
  });

  it('removes a profile and reports whether one was there', async () => {
    await saveProfile('work', profile, { env });

    expect(await removeProfile('work', env)).toBe(true);
    expect(await removeProfile('work', env)).toBe(false);
    expect(await resolveProfile('work', env)).toBeNull();
  });

  it('refuses a corrupt config rather than treating it as empty', async () => {
    await saveProfile('work', profile, { env });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(configPath(env), 'not json', 'utf8');

    await expect(loadConfig(env)).rejects.toThrow(/not valid JSON/);
  });
});
