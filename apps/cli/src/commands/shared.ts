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
export async function resolveSession(profileName: string | undefined, deps: SessionDeps = {}): Promise<Session> {
  const resolved = await resolveProfile(profileName, deps.env ?? process.env);
  if (resolved === null) {
    throw new Error(
      profileName === undefined
        ? 'No profile is signed in. Run `nixctl auth login` first.'
        : `No profile called '${profileName}'. Run \`nixctl auth login --profile ${profileName}\`.`,
    );
  }

  return openSession({
    profile: resolved.profile,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
}
