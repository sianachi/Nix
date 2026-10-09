/**
 * `nixctl auth`: signing in, checking who you are, and signing out.
 *
 * Browser login stores a revocable CLI session after browser consent and a successful identity
 * read. An explicit --token retains PAT login. Neither path writes an access token to disk.
 */

import { removeProfile, resolveProfile, saveProfile, type Profile } from '../config.ts';
import { openSession, whoami, type FetchImpl } from '../session.ts';
import { printResult, type OutputOptions } from '../output.ts';
import {
  cliAuthRequest,
  CliAuthRateLimitError,
  cliPollSchema,
  cliStartSchema,
  openLoginBrowser,
  revokeCliSession,
  trustedCoreUrl,
  trustedVerificationUrl,
  type CliAuthDeps,
} from '../cli-auth.ts';

export interface LoginInput {
  readonly apiUrl: string;
  readonly token?: string | undefined;
  readonly browserUrl?: string | undefined;
  readonly browser?: boolean | undefined;
  readonly profileName: string;
  readonly collabUrl?: string | undefined;
  readonly mediaUrl?: string | undefined;
  readonly makeDefault: boolean;
}

export interface LoginDeps extends CliAuthDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly openBrowser?: (url: string) => Promise<void>;
  readonly writeNotice?: (message: string) => void;
}

/**
 * Approves browser login or exchanges an explicit PAT, proves identity, and stores the profile.
 *
 * @returns The principal the token acts as.
 */
export async function login(
  input: LoginInput,
  output: OutputOptions,
  deps: LoginDeps = {},
): Promise<void> {
  const base: Profile = {
    apiUrl: trustedCoreUrl(input.apiUrl),
    token: input.token ?? '',
    ...(input.collabUrl !== undefined ? { collabUrl: normaliseUrl(input.collabUrl) } : {}),
    ...(input.mediaUrl !== undefined ? { mediaUrl: normaliseUrl(input.mediaUrl) } : {}),
  };
  const previous = await resolveProfile(input.profileName, deps.env ?? process.env);

  if (input.token === undefined) {
    await browserLogin(input, base, output, deps, previous?.profile);
    return;
  }

  // Prove it before it is written: whoami exchanges the token and reads the acting principal.
  const session = openSession({
    profile: base,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
  const principal = await whoami(session, deps.fetchImpl);

  await saveProfile(input.profileName, base, {
    makeDefault: input.makeDefault,
    ...(deps.env !== undefined ? { env: deps.env } : {}),
  });
  await revokeReplacedSession(previous?.profile, deps);

  printResult(
    {
      profile: input.profileName,
      apiUrl: base.apiUrl,
      authMethod: 'pat',
      principal: { id: principal.id, displayName: principal.displayName },
    },
    output,
  );
}

async function browserLogin(
  input: LoginInput,
  base: Profile,
  output: OutputOptions,
  deps: LoginDeps,
  previous: Profile | undefined,
): Promise<void> {
  const controller = new AbortController();
  const cancel = (): void => {
    controller.abort();
  };
  const signal =
    deps.signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, deps.signal]);
  const now = deps.now ?? Date.now;
  const notice =
    deps.writeNotice ??
    ((message: string): void => {
      process.stderr.write(message);
    });
  let granted: Profile | undefined;
  process.once('SIGINT', cancel);
  try {
    const start = await cliAuthRequest(base.apiUrl, '/auth/cli/start', {}, cliStartSchema, {
      ...deps,
      signal,
    });
    const verificationUri = trustedVerificationUrl(
      start.verificationUri,
      base.apiUrl,
      input.browserUrl,
      start.userCode,
    );
    const deadline = Math.min(Date.parse(start.expiresAt), now() + 10 * 60_000);
    if (deadline <= now())
      throw new Error('This browser login request has expired. Run `nixctl auth login` again.');
    notice(`Approve nixctl in Nix: ${verificationUri}\nConfirm code: ${start.userCode}\n`);
    if (input.browser !== false) {
      await (deps.openBrowser ?? openLoginBrowser)(verificationUri).catch(() => {
        notice('The browser could not be opened. Open the approval URL above to continue.\n');
      });
    }
    while (now() < deadline) {
      const remaining = deadline - now();
      const pollSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, remaining))]);
      const result = await cliAuthRequest(
        base.apiUrl,
        '/auth/cli/poll',
        { deviceCode: start.deviceCode },
        cliPollSchema,
        { ...deps, signal: pollSignal },
      ).catch(async (cause: unknown) => {
        if (!(cause instanceof CliAuthRateLimitError)) throw cause;
        await (deps.sleep ?? sleep)(
          Math.min(cause.retryAfterSeconds * 1000, Math.max(1, deadline - now())),
          signal,
        );
        return null;
      });
      if (result === null) continue;
      if (result.status === 'denied')
        throw new Error('Browser approval was denied. Your existing CLI profile was kept.');
      if (result.status === 'expired') break;
      if (result.status === 'approved') {
        granted = {
          ...base,
          interactiveSession: {
            refreshToken: result.refreshToken,
            expiresAt: result.sessionExpiresAt,
          },
        };
        if (
          Date.parse(result.expiresAt) <= now() ||
          Date.parse(result.expiresAt) > Date.parse(result.sessionExpiresAt)
        ) {
          throw new Error('Core returned an invalid CLI session expiry.');
        }
        const session = openSession({ profile: granted, bearerToken: result.accessToken });
        const principal = await whoami(session, async (url, init) => {
          try {
            const response = await (deps.fetchImpl ?? globalThis.fetch)(url, {
              ...init,
              redirect: 'error',
              signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
            });
            if (!response.ok) throw new Error('Identity read failed');
            return response;
          } catch {
            throw new Error('Core could not confirm the approved CLI identity.');
          }
        }).catch(() => {
          throw new Error('Core could not confirm the approved CLI identity.');
        });
        if (signal.aborted) throw new Error('CLI login was cancelled.');
        await saveProfile(input.profileName, granted, {
          makeDefault: input.makeDefault,
          ...(deps.env === undefined ? {} : { env: deps.env }),
        });
        granted = undefined;
        await revokeReplacedSession(previous, deps);
        printResult(
          {
            profile: input.profileName,
            apiUrl: base.apiUrl,
            authMethod: 'browser',
            sessionExpiresAt: result.sessionExpiresAt,
            principal: { id: principal.id, displayName: principal.displayName },
          },
          output,
        );
        return;
      }
      await (deps.sleep ?? sleep)(Math.min(start.intervalSeconds * 1000, deadline - now()), signal);
    }
    throw new Error(
      'Browser approval expired. Run `nixctl auth login` again. Your existing CLI profile was kept.',
    );
  } catch (cause) {
    if (granted !== undefined) {
      await revokeCliSession(
        granted,
        deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl },
      ).catch(() => {
        notice(
          'CLI setup failed and Core could not revoke the new session. Signing out of the approving browser session will revoke it.\n',
        );
      });
    }
    throw cause;
  } finally {
    process.removeListener('SIGINT', cancel);
  }
}

async function revokeReplacedSession(
  previous: Profile | undefined,
  deps: LoginDeps,
): Promise<void> {
  if (previous?.interactiveSession === undefined) return;
  await revokeCliSession(
    previous,
    deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl },
  ).catch(() => {
    const notice =
      deps.writeNotice ??
      ((message: string): void => {
        process.stderr.write(message);
      });
    notice(
      'The new CLI profile was saved, but Core could not confirm revocation of the previous CLI session. That session may remain valid until its expiry or until you sign out of its approving browser session.\n',
    );
  });
}

async function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error('CLI login was cancelled.');
  await new Promise<void>((resolve, reject) => {
    const cancel = (): void => {
      clearTimeout(timer);
      reject(new Error('CLI login was cancelled.'));
    };
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', cancel);
        resolve();
      },
      Math.max(1, milliseconds),
    );
    signal.addEventListener('abort', cancel, { once: true });
  });
}

/** Reports who the session acts as, or fails when the profile is unknown. */
export async function status(
  profileName: string | undefined,
  output: OutputOptions,
  deps: { readonly fetchImpl?: FetchImpl; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  const env = deps.env ?? process.env;
  const resolved = await resolveProfile(profileName, env);
  if (resolved === null) {
    throw new Error(
      profileName === undefined
        ? 'No profile is signed in. Run `nixctl auth login` first.'
        : `No profile called '${profileName}'. Run \`nixctl auth login --profile ${profileName}\`.`,
    );
  }

  const session = openSession({
    profile: resolved.profile,
    ...(env.NIX_SESSION_TOKEN === undefined ? {} : { bearerToken: env.NIX_SESSION_TOKEN }),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
  const principal = await whoami(session, deps.fetchImpl);

  printResult(
    {
      profile: resolved.name,
      apiUrl: resolved.profile.apiUrl,
      authMethod: resolved.profile.interactiveSession === undefined ? 'pat' : 'browser',
      ...(resolved.profile.interactiveSession === undefined
        ? {}
        : { sessionExpiresAt: resolved.profile.interactiveSession.expiresAt }),
      principal,
    },
    output,
  );
}

/** Revokes an interactive session before removing it; PAT logout only clears this machine. */
export async function logout(
  profileName: string | undefined,
  output: OutputOptions,
  deps: CliAuthDeps & { readonly env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  const env = deps.env ?? process.env;
  const resolved = await resolveProfile(profileName, env);
  const name = resolved?.name ?? profileName ?? 'default';
  if (resolved !== null) await revokeCliSession(resolved.profile, deps);
  const removed = await removeProfile(name, env);

  printResult(
    {
      profile: name,
      removed,
      note: removed
        ? resolved?.profile.interactiveSession === undefined
          ? 'The profile was removed from this machine. Revoke the token itself from your workspace settings.'
          : 'The CLI session was revoked and its profile was removed from this machine.'
        : 'There was no such profile to remove.',
    },
    output,
  );
}

/** Trim a trailing slash so a stored origin joins cleanly with a leading-slash path. */
function normaliseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}
