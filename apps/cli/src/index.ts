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
import { listWorkspaces } from './commands/workspaces.ts';
import { createItem, deleteItem, getItem, listItems, moveItem, renameItem, restoreItem } from './commands/items.ts';
import { readNote, writeNote } from './commands/notes.ts';
import { runQuery } from './commands/query.ts';
import { getViews, setViews } from './commands/views.ts';
import { getSchema, setProps, setSchema } from './commands/structure.ts';
import { runSearch } from './commands/search.ts';
import { runExport } from './commands/export.ts';
import { seed, stressRun } from './commands/stress.ts';
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

  const ws = program.command('ws').description('The workspaces a token can reach.');

  ws.command('list')
    .description('List every workspace the profile can reach.')
    .action(async (_options: unknown, command: Command) => {
      const flags = globalFlags(command);
      await run(() => listWorkspaces(flags.profile, outputOptions(flags.json)));
    });

  const note = program.command('note').description("A note's body, as Markdown.");

  note
    .command('read <itemId>')
    .description('Read a note body as Markdown.')
    .option('--raw', 'print only the Markdown text, even when piped', false)
    .action(async (itemId: string, options: { raw?: boolean }, command: Command) => {
      const flags = globalFlags(command);
      await run(() => readNote(flags.profile, itemId, { raw: options.raw === true }, outputOptions(flags.json)));
    });

  note
    .command('write <itemId>')
    .description('Replace a note body with Markdown from --file or stdin.')
    .option('--file <path>', 'read the Markdown from this file instead of stdin')
    .action(async (itemId: string, options: { file?: string }, command: Command) => {
      const flags = globalFlags(command);
      await run(() => writeNote(flags.profile, itemId, { file: options.file }, outputOptions(flags.json)));
    });

  const viewsCmd = program.command('views').description('The views a container offers over its children.');

  viewsCmd
    .command('get <itemId>')
    .description('List a container\'s views, which can render, and which opens by default.')
    .action(async (itemId: string, _options: unknown, command: Command) => {
      const flags = globalFlags(command);
      await run(() => getViews(flags.profile, itemId, outputOptions(flags.json)));
    });

  viewsCmd
    .command('set <itemId>')
    .description('Replace a container\'s view set from a JSON file.')
    .requiredOption('--file <path>', 'a JSON object { "views": [...], "default": <id|null> }')
    .action(async (itemId: string, options: { file: string }, command: Command) => {
      const flags = globalFlags(command);
      await run(() => setViews(flags.profile, itemId, options.file, outputOptions(flags.json)));
    });

  program
    .command('query <itemId>')
    .description("Run one of a container's views and print the children it shows.")
    .requiredOption('--view <viewId>', 'which of the container\'s views to run')
    .requiredOption('--today <yyyy-mm-dd>', "the caller's own day, for relative rules")
    .action(async (itemId: string, options: { view: string; today: string }, command: Command) => {
      const flags = globalFlags(command);
      await run(() => runQuery(flags.profile, itemId, { view: options.view, today: options.today }, outputOptions(flags.json)));
    });

  const schema = program.command('schema').description("An item's declared property schema.");

  schema
    .command('get <itemId>')
    .description('Read the property schema resolved at an item.')
    .action(async (itemId: string, _options: unknown, command: Command) => {
      const flags = globalFlags(command);
      await run(() => getSchema(flags.profile, itemId, outputOptions(flags.json)));
    });

  schema
    .command('set <itemId>')
    .description('Replace an item\'s declared schema from a JSON file.')
    .requiredOption('--file <path>', 'a JSON object { "properties": [...], "inherit": bool }')
    .action(async (itemId: string, options: { file: string }, command: Command) => {
      const flags = globalFlags(command);
      await run(() => setSchema(flags.profile, itemId, options.file, outputOptions(flags.json)));
    });

  const props = program.command('props').description("An item's property values.");

  props
    .command('set <itemId> [pairs...]')
    .description('Merge key=value property values onto an item (a null value clears a key).')
    .action(async (itemId: string, pairs: string[], _options: unknown, command: Command) => {
      const flags = globalFlags(command);
      await run(() => setProps(flags.profile, itemId, pairs, outputOptions(flags.json)));
    });

  program
    .command('search <query>')
    .description('Full-text search across the items you can see.')
    .option('--limit <n>', 'cap the number of hits', (value) => Number.parseInt(value, 10))
    .action(async (query: string, options: { limit?: number }, command: Command) => {
      const flags = globalFlags(command);
      await run(() => runSearch(flags.profile, query, { limit: options.limit }, outputOptions(flags.json)));
    });

  program
    .command('export <itemId>')
    .description('Download an export: nix (lossless) from collab, md/pdf/docx from media.')
    .option('--format <format>', 'nix | md | pdf | docx', 'nix')
    .option('--scope <scope>', 'item | subtree', 'item')
    .option('-o, --out <file>', 'write the export here instead of stdout')
    .action(async (itemId: string, options: { format: string; scope: string; out?: string }, command: Command) => {
      const flags = globalFlags(command);
      await run(() =>
        runExport(flags.profile, itemId, { format: options.format, scope: options.scope, out: options.out }, outputOptions(flags.json)),
      );
    });

  const stress = program.command('stress').description('Seed and exercise a workspace at scale.');

  stress
    .command('seed')
    .description('Create many children under a container, for the scale the stress rows name.')
    .requiredOption('--workspace <id>', 'the workspace to seed within')
    .requiredOption('--count <n>', 'how many children to create', (value) => Number.parseInt(value, 10))
    .option('--parent <id>', 'the container to seed under (default: create a new one)')
    .option('--title-prefix <p>', 'the prefix each child title carries', 'Item')
    .option('--type <type>', 'the body kind of each child', 'note')
    .action(async (options: SeedCliOptions, command: Command) => {
      const flags = globalFlags(command);
      await run(() =>
        seed(
          flags.profile,
          {
            workspaceId: options.workspace,
            count: options.count,
            parentId: options.parent,
            titlePrefix: options.titlePrefix,
            type: options.type,
          },
          outputOptions(flags.json),
        ),
      );
    });

  stress
    .command('run')
    .description('Run a stress scenario and print a machine-readable report.')
    .requiredOption('--scenario <name>', 'the scenario to run (read-storm, search-storm, query-storm)')
    .requiredOption('--iterations <n>', 'how many reads to make', (value) => Number.parseInt(value, 10))
    .option('--item <id>', 'read-storm/query-storm: the item (a container for query-storm) to read')
    .option('--query <text>', 'search-storm: the query to run each iteration')
    .option('--limit <n>', 'search-storm: cap the hits per query', (value) => Number.parseInt(value, 10))
    .option('--view <viewId>', 'query-storm: which of the container\'s views to run')
    .option('--today <yyyy-mm-dd>', 'query-storm: the caller\'s own day, for relative rules')
    .action(async (options: RunCliOptions, command: Command) => {
      const flags = globalFlags(command);
      await run(() =>
        stressRun(
          flags.profile,
          {
            scenario: options.scenario,
            iterations: options.iterations,
            itemId: options.item,
            query: options.query,
            limit: options.limit,
            viewId: options.view,
            today: options.today,
          },
          outputOptions(flags.json),
        ),
      );
    });

  const item = program.command('item').description('Read and write the item tree.');

  item
    .command('ls')
    .description("List a container's children, or the workspace roots.")
    .requiredOption('--workspace <id>', 'the workspace to list within')
    .option('--parent <id>', 'the container whose children to list (default: workspace roots)')
    .option('--deleted', 'include soft-deleted items', false)
    .action(async (options: LsOptions, command: Command) => {
      const flags = globalFlags(command);
      await run(() =>
        listItems(
          flags.profile,
          { workspaceId: options.workspace, parentId: options.parent, includeDeleted: options.deleted === true },
          outputOptions(flags.json),
        ),
      );
    });

  item
    .command('get <itemId>')
    .description('Read one item by id.')
    .action(async (itemId: string, _options: unknown, command: Command) => {
      const flags = globalFlags(command);
      await run(() => getItem(flags.profile, itemId, outputOptions(flags.json)));
    });

  item
    .command('create')
    .description('Create an item.')
    .requiredOption('--workspace <id>', 'the workspace to create in')
    .requiredOption('--title <title>', 'the item title')
    .option('--type <type>', 'the body kind', 'note')
    .option('--parent <id>', 'the parent container (default: workspace root)')
    .action(async (options: CreateItemOptions, command: Command) => {
      const flags = globalFlags(command);
      await run(() =>
        createItem(
          flags.profile,
          { workspaceId: options.workspace, type: options.type, title: options.title, parentId: options.parent },
          outputOptions(flags.json),
        ),
      );
    });

  item
    .command('edit <itemId>')
    .description('Rename an item.')
    .requiredOption('--workspace <id>', "the item's workspace")
    .requiredOption('--title <title>', 'the new title')
    .action(async (itemId: string, options: { workspace: string; title: string }, command: Command) => {
      const flags = globalFlags(command);
      await run(() => renameItem(flags.profile, itemId, options.workspace, options.title, outputOptions(flags.json)));
    });

  item
    .command('mv <itemId>')
    .description('Move an item to a new parent and position.')
    .requiredOption('--workspace <id>', "the item's workspace")
    .option('--parent <id>', 'the new parent, or omit for the workspace root')
    .option('--after <id>', 'the sibling to place it after, or omit to place it first')
    .action(async (itemId: string, options: MvOptions, command: Command) => {
      const flags = globalFlags(command);
      await run(() =>
        moveItem(
          flags.profile,
          itemId,
          { workspaceId: options.workspace, parentId: options.parent ?? null, afterId: options.after ?? null },
          outputOptions(flags.json),
        ),
      );
    });

  item
    .command('rm <itemId>')
    .description('Soft-delete an item; it can be restored until it is purged.')
    .requiredOption('--workspace <id>', "the item's workspace")
    .action(async (itemId: string, options: WorkspaceOption, command: Command) => {
      const flags = globalFlags(command);
      await run(() => deleteItem(flags.profile, itemId, options.workspace, outputOptions(flags.json)));
    });

  item
    .command('restore <itemId>')
    .description('Restore a soft-deleted item.')
    .requiredOption('--workspace <id>', "the item's workspace")
    .action(async (itemId: string, options: WorkspaceOption, command: Command) => {
      const flags = globalFlags(command);
      await run(() => restoreItem(flags.profile, itemId, options.workspace, outputOptions(flags.json)));
    });

  return program;
}

interface LsOptions {
  readonly workspace: string;
  readonly parent?: string;
  readonly deleted?: boolean;
}

interface CreateItemOptions {
  readonly workspace: string;
  readonly title: string;
  readonly type: string;
  readonly parent?: string;
}

interface MvOptions {
  readonly workspace: string;
  readonly parent?: string;
  readonly after?: string;
}

interface WorkspaceOption {
  readonly workspace: string;
}

interface SeedCliOptions {
  readonly workspace: string;
  readonly count: number;
  readonly parent?: string;
  readonly titlePrefix?: string;
  readonly type?: string;
}

interface RunCliOptions {
  readonly scenario: string;
  readonly iterations: number;
  readonly item?: string;
  readonly query?: string;
  readonly limit?: number;
  readonly view?: string;
  readonly today?: string;
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
