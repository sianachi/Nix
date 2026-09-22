/**
 * What every command that talks to the workspace needs: the resolved profile, opened as a session.
 *
 * A command that cannot find its profile fails with a sentence naming what to do, not with a stack
 * trace or a request to a server it has no address for - the same failure whether no profile is
 * signed in at all or a named one does not exist.
 */

import { resolveProfile } from '../config.ts';
import { openSession, type FetchImpl, type Session } from '../session.ts';

/** The seams a command exposes for tests: a fetch to stub, and a config environment to redirect. */
export interface SessionDeps {
  readonly fetchImpl?: FetchImpl;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Resolves the named profile (or the default) and opens a session for it.
 *
 * @throws When there is no such profile - the message names the fix.
 */
export async function resolveSession(
  profileName: string | undefined,
  deps: SessionDeps = {},
): Promise<Session> {
  const env = deps.env ?? process.env;
  const resolved = await resolveProfile(profileName, env);
  if (resolved === null) {
    throw new Error(
      profileName === undefined
        ? 'No profile is signed in. Run `nixctl auth login` first.'
        : `No profile called '${profileName}'. Run \`nixctl auth login --profile ${profileName}\`.`,
    );
  }

  return openSession({
    profile: resolved.profile,
    ...(env.NIX_SESSION_TOKEN === undefined ? {} : { bearerToken: env.NIX_SESSION_TOKEN }),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
}

/**
 * Mints the access token a command needs to speak to the collaboration service directly (as `note`
 * and `history` do), rather than through the Core client that mints its own.
 *
 * @throws When the profile's token cannot be exchanged for a session.
 */
export async function requireAccessToken(session: Session): Promise<string> {
  const token = await session.tokens.getAccessToken();
  if (token === null) {
    throw new Error('Could not obtain a session for this profile.');
  }
  return token;
}

/** Reads all of stdin as UTF-8, for commands that take their input piped in. */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
