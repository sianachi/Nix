/**
 * Where the CLI keeps what it needs to act as you: one file, one object per profile.
 *
 * **A personal access token is a credential, so the file it lives in is written 0600 and nothing
 * widens it.** A profile is a named set of endpoints and the token that reaches them, so a person
 * who works against a local stack and a shared one keeps two profiles rather than re-authenticating
 * each time. The token itself is the personal access token, not an exchanged session: the session
 * is short-lived and re-minted from this on demand (see `session.ts`), so what rests on disk is the
 * thing a person can revoke from the same screen that issued it.
 *
 * The location follows the XDG base-directory spec - `$XDG_CONFIG_HOME/nixctl/config.json`, or
 * `~/.config/nixctl/config.json` when that is unset - so it sits where a person's other tool config
 * does and a backup that takes `~/.config` takes this too.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';

/** One profile: where a workspace lives and the token that reaches it. */
export interface Profile {
  /** Core's base URL, e.g. `http://localhost:5014`. */
  readonly apiUrl: string;

  /** The personal access token, `nixpat_...`. Exchanged for a short-lived session per run. */
  readonly token: string;

  /** The collaboration service, for note bodies. Defaults are derived from `apiUrl` when absent. */
  readonly collabUrl?: string;

  /** The media service, for PDF/DOCX/Markdown export. */
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
  return base !== undefined && base.length > 0 ? join(base, 'nixctl') : join(homedir(), '.config', 'nixctl');
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
export async function removeProfile(name: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
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
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // Set the mode explicitly as well as at creation: writeFile's mode is a no-op when the file
  // already exists, so a file created before this rule was added is narrowed on the next write.
  await chmod(path, 0o600);
}

function normalise(value: unknown): Config {
  if (typeof value !== 'object' || value === null) {
    return EMPTY;
  }

  const record = value as Record<string, unknown>;
  const profilesRaw = typeof record.profiles === 'object' && record.profiles !== null ? record.profiles : {};
  const profiles: Record<string, Profile> = {};

  for (const [name, entry] of Object.entries(profilesRaw as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const profile = entry as Record<string, unknown>;
    if (typeof profile.apiUrl === 'string' && typeof profile.token === 'string') {
      profiles[name] = {
        apiUrl: profile.apiUrl,
        token: profile.token,
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

function isNotFound(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === 'ENOENT';
}
