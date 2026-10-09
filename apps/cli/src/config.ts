/**
 * Where the CLI keeps what it needs to act as you: one file, one object per profile.
 *
 * Credentials are written atomically with mode 0600. A profile holds either a personal access
 * token or a revocable browser-approved CLI session; short-lived access tokens remain in memory.
 *
 * The location follows the XDG base-directory spec - `$XDG_CONFIG_HOME/nixctl/config.json`, or
 * `~/.config/nixctl/config.json` when that is unset - so it sits where a person's other tool config
 * does and a backup that takes `~/.config` takes this too.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

/** One profile: where a workspace lives and the token that reaches it. */
export interface Profile {
  /** Core's base URL, e.g. `http://localhost:5014`. */
  readonly apiUrl: string;

  /** The personal access token, `nixpat_...`; empty for a browser-approved CLI session. */
  readonly token: string;

  /** A browser-approved, revocable credential with an absolute session expiry. */
  readonly interactiveSession?: {
    readonly refreshToken: string;
    readonly expiresAt: string;
  };

  /** The collaboration service, for note bodies. Defaults are derived from `apiUrl` when absent. */
  readonly collabUrl?: string;

  /** Legacy media endpoint retained when reading and rewriting existing profiles. */
  readonly mediaUrl?: string;
}

/** The whole config file: profiles by name, and which one is used when none is named. */
export interface Config {
  readonly defaultProfile: string;
  readonly profiles: Readonly<Record<string, Profile>>;
}

const EMPTY: Config = { defaultProfile: 'default', profiles: {} };

/** The directory the config file sits in. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME;
  return base !== undefined && base.length > 0
    ? join(base, 'nixctl')
    : join(homedir(), '.config', 'nixctl');
}

/** The config file's absolute path. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), 'config.json');
}

/**
 * Reads the whole config, or an empty one when there is no file yet.
 *
 * A missing file is the first-run state, not an error: `nixctl auth login` is what creates it, and
 * every read before that legitimately finds nothing. A file that exists but does not parse is a
 * different case and is reported, because silently treating a corrupt config as empty would drop a
 * token a person believes they still have.
 */
export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(configPath(env), 'utf8');
  } catch (cause) {
    if (isNotFound(cause)) {
      return EMPTY;
    }
    throw cause;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`The config at ${configPath(env)} is not valid JSON. Fix or remove it.`);
  }

  return normalise(parsed);
}

/**
 * Writes one profile, creating the file if it does not exist, and leaves it readable only by its
 * owner.
 *
 * @param name The profile's name.
 * @param profile The endpoints and token to store.
 * @param options Which becomes the default, and the environment to resolve the path against.
 */
export async function saveProfile(
  name: string,
  profile: Profile,
  options: { readonly makeDefault?: boolean; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const existing = await loadConfig(env);
  const next: Config = {
    defaultProfile: options.makeDefault === true ? name : existing.defaultProfile,
    profiles: { ...existing.profiles, [name]: profile },
  };

  await writeConfig(next, env);
}

/**
 * Removes one profile. Removing the default leaves the file without one until the next login names
 * a new default, which every command surfaces as "no profile" rather than acting under a guess.
 *
 * @returns Whether a profile was removed.
 */
export async function removeProfile(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const existing = await loadConfig(env);
  if (!(name in existing.profiles)) {
    return false;
  }

  const profiles = Object.fromEntries(
    Object.entries(existing.profiles).filter(([key]) => key !== name),
  );
  await writeConfig({ defaultProfile: existing.defaultProfile, profiles }, env);
  return true;
}

/**
 * Resolves the profile a command runs under: the one named, or the file's default.
 *
 * @param name The profile named on the command line, or undefined to use the default.
 * @returns The profile and its name, or null when there is none.
 */
export async function resolveProfile(
  name: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ readonly name: string; readonly profile: Profile } | null> {
  const config = await loadConfig(env);
  const resolved = name ?? config.defaultProfile;
  const profile = config.profiles[resolved];
  return profile === undefined ? null : { name: resolved, profile };
}

async function writeConfig(config: Config, env: NodeJS.ProcessEnv): Promise<void> {
  await mkdir(configDir(env), { recursive: true, mode: 0o700 });
  const path = configPath(env);
  const temporary = join(configDir(env), `.config-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(config, null, 2)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((cause: unknown) => {
      if (!isNotFound(cause)) throw cause;
    });
  }
}

function normalise(value: unknown): Config {
  if (typeof value !== 'object' || value === null) {
    return EMPTY;
  }

  const record = value as Record<string, unknown>;
  const profilesRaw =
    typeof record.profiles === 'object' && record.profiles !== null ? record.profiles : {};
  const profiles: Record<string, Profile> = {};

  for (const [name, entry] of Object.entries(profilesRaw as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const profile = entry as Record<string, unknown>;
    if (typeof profile.apiUrl === 'string' && typeof profile.token === 'string') {
      const interactiveSession = readInteractiveSession(profile.interactiveSession);
      if (profile.interactiveSession !== undefined && interactiveSession === undefined) continue;
      profiles[name] = {
        apiUrl: profile.apiUrl,
        token: profile.token,
        ...(interactiveSession === undefined ? {} : { interactiveSession }),
        ...(typeof profile.collabUrl === 'string' ? { collabUrl: profile.collabUrl } : {}),
        ...(typeof profile.mediaUrl === 'string' ? { mediaUrl: profile.mediaUrl } : {}),
      };
    }
  }

  return {
    defaultProfile: typeof record.defaultProfile === 'string' ? record.defaultProfile : 'default',
    profiles,
  };
}

function readInteractiveSession(value: unknown): Profile['interactiveSession'] {
  if (typeof value !== 'object' || value === null) return undefined;
  const session = value as Record<string, unknown>;
  return typeof session.refreshToken === 'string' &&
    session.refreshToken.startsWith('nixcli_') &&
    typeof session.expiresAt === 'string' &&
    Number.isFinite(Date.parse(session.expiresAt))
    ? { refreshToken: session.refreshToken, expiresAt: session.expiresAt }
    : undefined;
}

function isNotFound(cause: unknown): boolean {
  return (
    typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === 'ENOENT'
  );
}
