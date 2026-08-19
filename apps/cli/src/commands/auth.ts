/**
 * `nixctl auth`: signing in, checking who you are, and signing out.
 *
 * **Signing in proves the token before it is written.** A personal access token is exchanged for a
 * session and that session is asked who it is; only a token that mints a working session is stored,
 * so a mistyped or already-revoked token fails at the prompt rather than being saved and failing on
 * the next command. Signing out removes the profile - the token is revoked from the web workspace,
 * not from here, so `logout` clears the machine and never claims to have ended the credential.
 */

import { removeProfile, resolveProfile, saveProfile, type Profile } from '../config.ts';
import { openSession, whoami, type FetchImpl } from '../session.ts';
import { printResult, type OutputOptions } from '../output.ts';

export interface LoginInput {
  readonly apiUrl: string;
  readonly token: string;
  readonly profileName: string;
  readonly collabUrl?: string | undefined;
  readonly mediaUrl?: string | undefined;
  readonly makeDefault: boolean;
}

/**
 * Exchanges the token, confirms it, and stores the profile.
 *
 * @returns The principal the token acts as.
 */
export async function login(
  input: LoginInput,
  output: OutputOptions,
  deps: { readonly fetchImpl?: FetchImpl; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  const profile: Profile = {
    apiUrl: normaliseUrl(input.apiUrl),
    token: input.token,
    ...(input.collabUrl !== undefined ? { collabUrl: normaliseUrl(input.collabUrl) } : {}),
    ...(input.mediaUrl !== undefined ? { mediaUrl: normaliseUrl(input.mediaUrl) } : {}),
  };

  // Prove it before it is written: whoami exchanges the token and reads the acting principal.
  const session = openSession({ profile, ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}) });
  const principal = await whoami(session, deps.fetchImpl);

  await saveProfile(input.profileName, profile, {
    makeDefault: input.makeDefault,
    ...(deps.env !== undefined ? { env: deps.env } : {}),
  });

  printResult(
    {
      profile: input.profileName,
      apiUrl: profile.apiUrl,
      principal: { id: principal.id, displayName: principal.displayName },
    },
    output,
  );
}

/** Reports who the session acts as, or fails when the profile is unknown. */
export async function status(
  profileName: string | undefined,
  output: OutputOptions,
  deps: { readonly fetchImpl?: FetchImpl; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  const resolved = await resolveProfile(profileName, deps.env ?? process.env);
  if (resolved === null) {
    throw new Error(
      profileName === undefined
        ? 'No profile is signed in. Run `nixctl auth login` first.'
        : `No profile called '${profileName}'. Run \`nixctl auth login --profile ${profileName}\`.`,
    );
  }

  const session = openSession({
    profile: resolved.profile,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
  const principal = await whoami(session, deps.fetchImpl);

  printResult(
    {
      profile: resolved.name,
      apiUrl: resolved.profile.apiUrl,
      principal,
    },
    output,
  );
}

/** Removes a profile from this machine. */
export async function logout(
  profileName: string | undefined,
  output: OutputOptions,
  deps: { readonly env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  const env = deps.env ?? process.env;
  const resolved = await resolveProfile(profileName, env);
  const name = resolved?.name ?? profileName ?? 'default';
  const removed = await removeProfile(name, env);

  printResult(
    {
      profile: name,
      removed,
      note: removed
        ? 'The profile was removed from this machine. Revoke the token itself from your workspace settings.'
        : 'There was no such profile to remove.',
    },
    output,
  );
}

/** Trim a trailing slash so a stored origin joins cleanly with a leading-slash path. */
function normaliseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}
