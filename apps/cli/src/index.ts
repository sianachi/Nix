#!/usr/bin/env -S node --experimental-strip-types
/**
 * `nixctl`: the scriptable way into a Nix workspace.
 *
 * **The output is machine-readable by default and the process leaves with a code a script can
 * branch on**, which is what makes this the surface an agent or a shell loop drives rather than a
 * person clicking. Every command routes its result through `printResult` and its failure through
 * `printError`, so the two streams stay apart and the exit code is never an afterthought.
 *
 * Commands are thin: parse the flags, open a session, call the use case, print the result. The work
 * lives in `commands/` and in the packages this shares with the web application, so a behaviour is
 * defined once and reached two ways.
 */

import { Command } from 'commander';
import { login, logout, status } from './commands/auth.ts';
import { outputOptions, printError, ExitCode } from './output.ts';

interface GlobalFlags {
  readonly profile: string | undefined;
  readonly json: boolean;
}

function globalFlags(command: Command): GlobalFlags {
  const opts = command.optsWithGlobals();
  return {
    profile: typeof opts.profile === 'string' ? opts.profile : undefined,
    json: opts.json === true,
  };
}

/**
 * Runs one command's body, turning anything thrown into a stderr line and an exit code.
 *
 * Kept in one place so no command forgets it: a throw that reached the top would print a stack
 * trace, which is neither the honest failure a person wants nor the parseable one a script does.
 */
async function run(body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (error) {
    process.exitCode = printError(error);
  }
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('nixctl')
    .description('Drive a Nix workspace from the terminal.')
    .option('--profile <name>', 'the stored profile to act as')
    .option('--json', 'force machine-readable output even on a terminal', false)
    .configureOutput({
      // Usage and option errors are diagnostics, so they belong on stderr with the results kept
      // clean on stdout.
      writeErr: (text) => process.stderr.write(text),
    });

  const auth = program.command('auth').description('Sign in, check who you are, and sign out.');

  auth
    .command('login')
    .description('Store a personal access token after proving it mints a session.')
    .requiredOption('--api-url <url>', "Core's base URL, e.g. http://localhost:5014")
    .requiredOption('--token <token>', 'a personal access token, nixpat_...')
    .option('--collab-url <url>', 'the collaboration service URL (defaults from the API URL)')
    .option('--media-url <url>', 'the media service URL (defaults from the API URL)')
    .option('--no-default', 'store the profile without making it the default')
    .action(async (options: LoginOptions, command: Command) => {
      const flags = globalFlags(command);
      await run(() =>
        login(
          {
            apiUrl: options.apiUrl,
            token: options.token,
            profileName: flags.profile ?? 'default',
            collabUrl: options.collabUrl,
            mediaUrl: options.mediaUrl,
            makeDefault: options.default !== false,
          },
          outputOptions(flags.json),
        ),
      );
    });

  auth
    .command('status')
    .description('Show who the current profile acts as.')
    .action(async (_options: unknown, command: Command) => {
      const flags = globalFlags(command);
      await run(() => status(flags.profile, outputOptions(flags.json)));
    });

  auth
    .command('logout')
    .description('Remove a profile from this machine.')
    .action(async (_options: unknown, command: Command) => {
      const flags = globalFlags(command);
      await run(() => logout(flags.profile, outputOptions(flags.json)));
    });

  return program;
}

interface LoginOptions {
  readonly apiUrl: string;
  readonly token: string;
  readonly collabUrl?: string;
  readonly mediaUrl?: string;
  /** commander sets this false when `--no-default` is passed. */
  readonly default?: boolean;
}

// Run only when invoked as the binary, not when imported by a test.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  buildProgram()
    .parseAsync(process.argv)
    .catch((error: unknown) => {
      process.exitCode = printError(error);
    });
}

export { ExitCode };
