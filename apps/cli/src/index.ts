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
import {
  changeWorkspaceMemberRole,
  acceptWorkspaceInvitation,
  archiveWorkspace,
  createWorkspace,
  declineWorkspaceInvitation,
  inviteWorkspaceMember,
  leaveWorkspace,
  listWorkspaceInvitations,
  listWorkspaceInvitees,
  listWorkspaceMembers,
  listWorkspaceAssignablePrincipals,
  listWorkspaces,
  purgeWorkspace,
  removeWorkspaceMember,
  renameWorkspace,
  restoreWorkspace,
  revokeWorkspaceInvitation,
} from './commands/workspaces.ts';
import {
  createItem,
  deleteItem,
  getItem,
  listItems,
  moveItem,
  renameItem,
  restoreItem,
} from './commands/items.ts';
import { readNote, writeNote } from './commands/notes.ts';
import {
  listHistory,
  listHistoryVersions,
  nameHistoryVersion,
  restoreHistory,
  showHistory,
} from './commands/history.ts';
import { runQuery } from './commands/query.ts';
import { getViews, inspectViews, setViews } from './commands/views.ts';
import { getSchema, setProps, setSchema } from './commands/structure.ts';
import {
  clearRecurrence,
  completeRecurrence,
  runCalendar,
  setRecurrence,
} from './commands/recurrence.ts';
import { runSearch } from './commands/search.ts';
import { runExport } from './commands/export.ts';
import { runImport } from './commands/import.ts';
import {
  cancelDocumentImport,
  commitDocumentImport,
  getDocumentImport,
} from './commands/document-import.ts';
import { downloadFile, listFileVersions, uploadFile } from './commands/files.ts';
import { getOperation } from './commands/operations.ts';
import { seed, stressRun } from './commands/stress.ts';
import { outputOptions, printError, printResult, ExitCode } from './output.ts';
import { runWorkspaceMcpServer } from './mcp.ts';
import { petCommand, type PetOptions } from './commands/pets.ts';
import { checkIn, readHabit, setHabit, setHabitStatus, undoCheckIn } from './commands/habits.ts';
import {
  applyTemplate,
  captureTemplate,
  cancelTemplateArchiveImport,
  commitTemplateArchive,
  exportTemplateArchive,
  getTemplate,
  getTemplateImport,
  listTemplates,
  beginTemplateDraft,
  getTemplateDraft,
  updateTemplateDraftFromFile,
  updateTemplateDraftItemFromFile,
  saveTemplateDraft,
  discardTemplateDraft,
  resumeTemplateOperation,
  preflightTemplate,
  previewTemplateArchive,
  updateTemplateInitialization,
} from './commands/templates.ts';

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
  program
    .command('pet <operation>')
    .description(
      'Inspect or drive companions. Runtime calls require an interactive NIX_SESSION_TOKEN and --api-url; PAT permissions are not expanded.',
    )
    .option('--api-url <url>', 'Core origin for a short-lived interactive session token')
    .option('--workspace <id>', 'workspace identity')
    .option('--pet <id>', 'saved pet identity')
    .option('--message <text>', 'message to send')
    .option('--model <id>', 'model from pet models')
    .option(
      '--workspace-tools',
      'offer workspace tools; approve requests in the Nix companion panel',
      false,
    )
    .action(async (operation: string, options: PetOptions, command: Command) => {
      const flags = globalFlags(command);
      await run(() => petCommand(flags.profile, operation, options, outputOptions(flags.json)));
    });

  auth
    .command('login')
    .description('Store a personal access token after proving it mints a session.')
    .requiredOption('--api-url <url>', "Core's base URL, e.g. http://localhost:5014")
    .requiredOption('--token <token>', 'a personal access token, nixpat_...')
    .option('--collab-url <url>', 'the collaboration service URL (defaults from the API URL)')
    .option('--media-url <url>', 'legacy media URL retained in the profile for compatibility')
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

  program
    .command('operation')
    .description('Inspect a durable operation visible to the current profile.')
    .command('get <operationId>')
    .description('Read the current state of an authorized operation.')
    .action(async (operationId: string, _options: unknown, command: Command) => {
      const flags = globalFlags(command);
      await run(() => getOperation(flags.profile, operationId, outputOptions(flags.json)));
    });

  ws.command('list')
    .description('List one page of workspaces the profile can reach.')
    .option('--limit <count>', 'maximum rows in this page', parseInteger, 50)
    .option('--cursor <cursor>', 'opaque cursor returned by the previous page')
    .action(async (options: PageCliOptions, command: Command) => {
      const flags = globalFlags(command);
      await run(() => listWorkspaces(flags.profile, options, outputOptions(flags.json)));
    });

  ws.command('create <name>')
    .description('Create a shared workspace.')
    .action(async (name: string, _options: unknown, command: Command) => {
      const flags = globalFlags(command);
      await run(() => createWorkspace(flags.profile, name, outputOptions(flags.json)));
    });
  ws.command('rename <workspaceId> <name>')
    .description('Rename a workspace.')
    .action(async (workspaceId: string, name: string, _options: unknown, command: Command) => {
      const flags = globalFlags(command);
      await run(() => renameWorkspace(flags.profile, workspaceId, name, outputOptions(flags.json)));
    });
  ws.command('archive <workspaceId>')
    .description('Archive a workspace so it is out of everyday navigation.')
    .option('--yes', 'confirm this destructive operation', false)
    .action(async (workspaceId: string, options: ConfirmCliOptions, command: Command) => {
      const flags = globalFlags(command);
      await run(() =>
        archiveWorkspace(
          flags.profile,
          workspaceId,
          options.yes === true,
          outputOptions(flags.json),
        ),
      );
    });
  ws.command('restore <workspaceId>')
    .description('Restore an archived workspace.')
    .action(async (workspaceId: string, _options: unknown, command: Command) => {
      const flags = globalFlags(command);
      await run(() => restoreWorkspace(flags.profile, workspaceId, outputOptions(flags.json)));
    });
  ws.command('purge <workspaceId>')
    .description('Permanently delete an archived workspace and its stored files.')
    .option('--yes', 'confirm this irreversible operation', false)
    .action(async (workspaceId: string, options: ConfirmCliOptions, command: Command) => {
      const flags = globalFlags(command);
      await run(() =>
        purgeWorkspace(flags.profile, workspaceId, options.yes === true, outputOptions(flags.json)),
      );
    });
  ws.command('invitations <workspaceId>')
    .description('List invitation history.')
    .option('--limit <count>', 'maximum rows in this page', parseInteger, 50)
    .option('--cursor <cursor>', 'opaque cursor returned by the previous page')
    .action(async (workspaceId: string, options: PageCliOptions, command: Command) => {
      const flags = globalFlags(command);
      await run(() =>
        listWorkspaceInvitations(flags.profile, workspaceId, options, outputOptions(flags.json)),
      );
    });
  ws.command('invitees <workspaceId>')
    .description('List active users who can be invited.')
    .option('--limit <count>', 'maximum rows in this page', parseInteger, 50)
    .option('--cursor <cursor>', 'opaque cursor returned by the previous page')
    .action(async (workspaceId: string, options: PageCliOptions, command: Command) => {
      const flags = globalFlags(command);
      await run(() =>
        listWorkspaceInvitees(flags.profile, workspaceId, options, outputOptions(flags.json)),
      );
    });
  ws.command('invite <workspaceId> <principalId>')
    .requiredOption('--role <role>', 'owner, editor, or viewer')
    .description('Invite a collaborator.')
    .action(
      async (
        workspaceId: string,
        principalId: string,
        options: { role: string },
        command: Command,
      ) => {
        const flags = globalFlags(command);
        await run(() =>
          inviteWorkspaceMember(
            flags.profile,
            workspaceId,
            principalId,
            options.role,
            outputOptions(flags.json),
          ),
        );
      },
    );
  ws.command('accept-invite <workspaceId> <invitationId>')
    .description('Accept an invitation addressed to the current principal.')
    .action(
      async (workspaceId: string, invitationId: string, _options: unknown, command: Command) => {
        const flags = globalFlags(command);
        await run(() =>
          acceptWorkspaceInvitation(
            flags.profile,
            workspaceId,
            invitationId,
            outputOptions(flags.json),
          ),
        );
      },
    );
  ws.command('decline-invite <workspaceId> <invitationId>')
    .description('Decline an invitation and remove provisional access.')
    .option('--yes', 'confirm this destructive operation', false)
    .action(
      async (
        workspaceId: string,
        invitationId: string,
        options: ConfirmCliOptions,
        command: Command,
      ) => {
        const flags = globalFlags(command);
        await run(() =>
          declineWorkspaceInvitation(
            flags.profile,
            workspaceId,
            invitationId,
            options.yes === true,
            outputOptions(flags.json),
          ),
        );
      },
    );
  ws.command('revoke-invite <workspaceId> <invitationId>')
    .description('Revoke a pending invitation.')
    .option('--yes', 'confirm this destructive operation', false)
    .action(
      async (
        workspaceId: string,
        invitationId: string,
        options: ConfirmCliOptions,
        command: Command,
      ) => {
        const flags = globalFlags(command);
        await run(() =>
          revokeWorkspaceInvitation(
            flags.profile,
            workspaceId,
            invitationId,
            options.yes === true,
            outputOptions(flags.json),
          ),
        );
      },
    );
  ws.command('members <workspaceId>')
    .description('List principal and group workspace grants.')
    .option('--limit <count>', 'maximum rows in this page', parseInteger, 50)
    .option('--cursor <cursor>', 'opaque cursor returned by the previous page')
    .action(async (workspaceId: string, options: PageCliOptions, command: Command) => {
      const flags = globalFlags(command);
      await run(() =>
        listWorkspaceMembers(flags.profile, workspaceId, options, outputOptions(flags.json)),
      );
    });
  ws.command('principals <workspaceId>')
    .description('List active direct and group-derived principals available for assignment.')
    .option('--query <text>', 'filter display names by text')
    .option('--limit <count>', 'maximum rows in this page', parseInteger, 50)
    .option('--cursor <cursor>', 'opaque cursor returned by the previous page')
    .action(
      async (
        workspaceId: string,
        options: PageCliOptions & { query?: string },
        command: Command,
      ) => {
        const flags = globalFlags(command);
        await run(() =>
          listWorkspaceAssignablePrincipals(
            flags.profile,
            workspaceId,
            options,
            outputOptions(flags.json),
          ),
        );
      },
    );
  ws.command('role <workspaceId> <principalId>')
    .requiredOption('--role <role>', 'owner, editor, or viewer')
    .description('Change a member role.')
    .action(
      async (
        workspaceId: string,
        principalId: string,
        options: { role: string },
        command: Command,
      ) => {
        const flags = globalFlags(command);
        await run(() =>
          changeWorkspaceMemberRole(
            flags.profile,
            workspaceId,
            principalId,
            options.role,
            outputOptions(flags.json),
          ),
        );
      },
    );
  ws.command('remove <workspaceId> <principalId>')
    .description('Remove a workspace member.')
    .option('--yes', 'confirm this destructive operation', false)
    .action(
      async (
        workspaceId: string,
        principalId: string,
        options: ConfirmCliOptions,
        command: Command,
      ) => {
        const flags = globalFlags(command);
        await run(() =>
          removeWorkspaceMember(
            flags.profile,
            workspaceId,
            principalId,
            options.yes === true,
            outputOptions(flags.json),
          ),
        );
      },
    );
  ws.command('leave <workspaceId>')
    .description('Leave a workspace.')
    .option('--yes', 'confirm this destructive operation', false)
    .action(async (workspaceId: string, options: ConfirmCliOptions, command: Command) => {
      const flags = globalFlags(command);
      await run(() =>
        leaveWorkspace(flags.profile, workspaceId, options.yes === true, outputOptions(flags.json)),
      );
    });

  program
    .command('mcp')
    .description('Serve Nix workspace tools over MCP on stdio.')
    .action(async (_options: unknown, command: Command) => {
      const flags = globalFlags(command);
      await run(() => runWorkspaceMcpServer(flags.profile));
    });

  const template = program
    .command('template')
    .description('List, capture, initialize, and apply workspace templates.');

  const draft = template
    .command('draft')
    .description('Open and manage a resumable editable template draft.');
  draft
    .command('begin <templateId>')
    .description('Copy a template into a draft and wait for any file transfer to finish.')
    .option('--idempotency-key <key>', 'reuse a key to resume the same draft copy')
    .option('--no-wait', 'return a resumable receipt while files copy in the background')
    .action(
      async (
        templateId: string,
        options: { idempotencyKey?: string; wait?: boolean },
        command: Command,
      ) => {
        const flags = globalFlags(command);
        await run(() =>
          beginTemplateDraft(
            flags.profile,
            templateId,
            {
              ...(options.idempotencyKey === undefined
                ? {}
                : { idempotencyKey: options.idempotencyKey }),
              noWait: options.wait === false,
            },
            outputOptions(flags.json),
          ),
        );
      },
    );
  draft
    .command('show <templateId> <operationId>')
    .description('Read the current draft tree and metadata.')
    .action(
      async (templateId: string, operationId: string, _options: unknown, command: Command) => {
        const flags = globalFlags(command);
        await run(() =>
          getTemplateDraft(flags.profile, templateId, operationId, outputOptions(flags.json)),
        );
      },
    );
  draft
    .command('update <templateId> <operationId>')
    .description('Patch draft title, description, or initialization from a JSON file.')
    .requiredOption('--file <path>', 'JSON object containing the draft metadata patch')
    .action(
      async (
        templateId: string,
        operationId: string,
        options: { file: string },
        command: Command,
      ) => {
        const flags = globalFlags(command);
        await run(() =>
          updateTemplateDraftFromFile(
            flags.profile,
            templateId,
            operationId,
            options.file,
            outputOptions(flags.json),
          ),
        );
      },
    );
  draft
    .command('update-item <templateId> <operationId> <sourceId>')
    .description('Patch one draft item from a JSON file.')
    .requiredOption('--file <path>', 'JSON object containing the item patch')
    .action(
      async (
        templateId: string,
        operationId: string,
        sourceId: string,
        options: { file: string },
        command: Command,
      ) => {
        const flags = globalFlags(command);
        await run(() =>
          updateTemplateDraftItemFromFile(
            flags.profile,
            templateId,
            operationId,
            sourceId,
            options.file,
            outputOptions(flags.json),
          ),
        );
      },
    );
  draft
    .command('save <templateId> <operationId>')
    .description('Publish the completed draft as the new template revision.')
    .action(
      async (templateId: string, operationId: string, _options: unknown, command: Command) => {
        const flags = globalFlags(command);
        await run(() =>
          saveTemplateDraft(flags.profile, templateId, operationId, outputOptions(flags.json)),
        );
      },
    );
  draft
    .command('discard <templateId> <operationId>')
    .description('Discard an unfinished draft and its copied bodies.')
    .action(
      async (templateId: string, operationId: string, _options: unknown, command: Command) => {
        const flags = globalFlags(command);
        await run(() =>
          discardTemplateDraft(flags.profile, templateId, operationId, outputOptions(flags.json)),
        );
      },
    );
  template
    .command('resume <receiptPath>')
    .description('Poll a template file-copy job and replay its original idempotent command.')
    .action(async (receiptPath: string, _options: unknown, command: Command) => {
      const flags = globalFlags(command);
      await run(() =>
        resumeTemplateOperation(flags.profile, receiptPath, outputOptions(flags.json)),
      );
    });

  template
    .command('list <workspaceId>')
    .description('List templates visible in a workspace.')
    .action(async (workspaceId: string, _options: unknown, command: Command) => {
      const flags = globalFlags(command);
      await run(() => listTemplates(flags.profile, workspaceId, outputOptions(flags.json)));
    });

  template
    .command('show <templateId>')
    .description('Read one template and its initialization questions.')
    .action(async (templateId: string, _options: unknown, command: Command) => {
      const flags = globalFlags(command);
      await run(() => getTemplate(flags.profile, templateId, outputOptions(flags.json)));
    });

  template
    .command('capture <workspaceId> <sourceItemId>')
    .description('Capture an item tree as a reusable template.')
    .requiredOption('--title <title>', 'template name')
    .option('--idempotency-key <key>', 'reuse a key to resume a pending capture')
    .option('--description <text>', 'when this starting point is useful')
    .option('--include-body', 'copy body content', false)
    .option('--include-children', 'copy readable descendants', false)
    .option('--no-wait', 'return a resumable receipt while files copy in the background')
    .action(
      async (
        workspaceId: string,
        sourceItemId: string,
        options: {
          title: string;
          description?: string;
          idempotencyKey?: string;
          includeBody?: boolean;
          includeChildren?: boolean;
          wait?: boolean;
        },
        command: Command,
      ) => {
        const flags = globalFlags(command);
        await run(() =>
          captureTemplate(
            flags.profile,
            {
              workspaceId,
              sourceItemId,
              title: options.title,
              includeBody: options.includeBody === true,
              includeChildren: options.includeChildren === true,
              ...(options.description === undefined ? {} : { description: options.description }),
              ...(options.idempotencyKey === undefined
                ? {}
                : { idempotencyKey: options.idempotencyKey }),
            },
            outputOptions(flags.json),
            undefined,
            undefined,
            options.wait !== false,
          ),
        );
      },
    );

  template
    .command('initialize <templateId>')
    .description('Replace a template’s setup questions and field rules from a JSON file.')
    .requiredOption('--file <path>', 'strict version 1 initialization JSON')
    .option('--title <title>', 'rename the template')
    .option('--description <text>', 'update its description')
    .option('--idempotency-key <key>', 'reuse a key to resume a pending draft update')
    .option('--no-wait', 'return a resumable receipt while files copy in the background')
    .action(
      async (
        templateId: string,
        options: {
          file: string;
          title?: string;
          description?: string;
          idempotencyKey?: string;
          wait?: boolean;
        },
        command: Command,
      ) => {
        const flags = globalFlags(command);
        await run(() =>
          updateTemplateInitialization(
            flags.profile,
            templateId,
            options.file,
            {
              ...(options.title === undefined ? {} : { title: options.title }),
              ...(options.description === undefined ? {} : { description: options.description }),
              ...(options.idempotencyKey === undefined
                ? {}
                : { idempotencyKey: options.idempotencyKey }),
            },
            outputOptions(flags.json),
            undefined,
            options.wait !== false,
          ),
        );
      },
    );

  template
    .command('apply <templateId>')
    .description('Preflight and apply a template to an item or as a new child.')
    .requiredOption('--mode <mode>', 'merge or create')
    .option('--target <itemId>', 'existing item for merge mode')
    .option('--parent <itemId>', 'parent item for create mode')
    .option('--title <title>', 'title for the created item')
    .option(
      '--input <key=value>',
      'answer one setup question; repeat for each answer',
      collectOption,
      [],
    )
    .option('--expected-revision <revision>', 'refuse a changed template revision', parseInteger)
    .option('--idempotency-key <key>', 'reuse a key to resume a pending application')
    .option('--no-wait', 'return a resumable receipt while files copy in the background')
    .action(
      async (
        templateId: string,
        options: {
          mode: 'merge' | 'create';
          target?: string;
          parent?: string;
          title?: string;
          input?: string[];
          expectedRevision?: number;
          idempotencyKey?: string;
          wait?: boolean;
        },
        command: Command,
      ) => {
        const flags = globalFlags(command);
        await run(() =>
          applyTemplate(
            flags.profile,
            {
              templateId,
              mode: options.mode,
              ...(options.target === undefined ? {} : { targetItemId: options.target }),
              ...(options.parent === undefined ? {} : { parentItemId: options.parent }),
              ...(options.title === undefined ? {} : { title: options.title }),
              ...(options.input === undefined
                ? {}
                : { inputs: parseTemplateInputPairs(options.input) }),
              ...(options.expectedRevision === undefined
                ? {}
                : { expectedRevision: options.expectedRevision }),
              ...(options.idempotencyKey === undefined
                ? {}
                : { idempotencyKey: options.idempotencyKey }),
            },
            outputOptions(flags.json),
            undefined,
            options.wait !== false,
          ),
        );
      },
    );

  template
    .command('preflight <templateId>')
    .description('Resolve setup questions and preview a template without creating items.')
    .requiredOption('--mode <mode>', 'merge or create')
    .option('--target <itemId>', 'existing item for merge mode')
    .option('--parent <itemId>', 'parent item for create mode')
    .option('--title <title>', 'title for the created item')
    .option(
      '--input <key=value>',
      'answer one setup question; repeat for each answer',
      collectOption,
      [],
    )
    .option('--expected-revision <revision>', 'preview only this template revision', parseInteger)
    .action(
      async (
        templateId: string,
        options: {
          mode: 'merge' | 'create';
          target?: string;
          parent?: string;
          title?: string;
          input?: string[];
          expectedRevision?: number;
        },
        command: Command,
      ) => {
        const flags = globalFlags(command);
        await run(() =>
          preflightTemplate(
            flags.profile,
            {
              templateId,
              mode: options.mode,
              ...(options.target === undefined ? {} : { targetItemId: options.target }),
              ...(options.parent === undefined ? {} : { parentItemId: options.parent }),
              ...(options.title === undefined ? {} : { title: options.title }),
              ...(options.input === undefined
                ? {}
                : { inputs: parseTemplateInputPairs(options.input) }),
              ...(options.expectedRevision === undefined
                ? {}
                : { expectedRevision: options.expectedRevision }),
            },
            outputOptions(flags.json),
          ),
        );
      },
    );

  template
    .command('import <workspaceId> <path>')
    .description('Upload a portable template archive and print its validated preview and digest.')
    .option('--idempotency-key <key>', 'reuse a key to resume the same archive preview')
    .action(
      async (
        workspaceId: string,
        path: string,
        options: { idempotencyKey?: string },
        command: Command,
      ) => {
        const flags = globalFlags(command);
        await run(() =>
          previewTemplateArchive(
            flags.profile,
            workspaceId,
            path,
            options,
            outputOptions(flags.json),
          ),
        );
      },
    );

  template
    .command('import-commit <importId> <digest>')
    .description('Publish a previewed template archive using the exact digest returned by import.')
    .action(async (importId: string, digest: string, _options: unknown, command: Command) => {
      const flags = globalFlags(command);
      await run(() =>
        commitTemplateArchive(flags.profile, importId, digest, outputOptions(flags.json)),
      );
    });

  template
    .command('import-get <importId>')
    .description('Read the current state of an authorized template archive import.')
    .action(async (importId: string, _options: unknown, command: Command) => {
      const flags = globalFlags(command);
      await run(() => getTemplateImport(flags.profile, importId, outputOptions(flags.json)));
    });

  template
    .command('import-cancel <importId>')
    .description('Cancel an authorized template archive import and its pending worker execution.')
    .option('--yes', 'confirm cancellation of this import', false)
    .action(async (importId: string, options: { yes?: boolean }, command: Command) => {
      const flags = globalFlags(command);
      if (options.yes !== true) {
        throw new Error('Pass --yes to confirm cancellation of this template archive import.');
      }
      await run(() =>
        cancelTemplateArchiveImport(flags.profile, importId, outputOptions(flags.json)),
      );
    });

  template
    .command('export <templateId>')
    .description('Download a portable template archive from the authorized Collab service.')
    .requiredOption('-o, --out <path>', 'write the archive here')
    .action(async (templateId: string, options: { out: string }, command: Command) => {
      const flags = globalFlags(command);
      await run(() =>
        exportTemplateArchive(flags.profile, templateId, options.out, outputOptions(flags.json)),
      );
    });

  const note = program.command('note').description("A note's body, as Markdown.");

  note
    .command('read <itemId>')
    .description('Read a note body as Markdown.')
    .option('--raw', 'print only the Markdown text, even when piped', false)
    .action(async (itemId: string, options: { raw?: boolean }, command: Command) => {
      const flags = globalFlags(command);
      await run(() =>
        readNote(flags.profile, itemId, { raw: options.raw === true }, outputOptions(flags.json)),
      );
    });

  note
    .command('write <itemId>')
    .description('Replace a note body with Markdown from --file or stdin.')
    .option('--file <path>', 'read the Markdown from this file instead of stdin')
    .action(async (itemId: string, options: { file?: string }, command: Command) => {
      const flags = globalFlags(command);
      await run(() =>
        writeNote(flags.profile, itemId, { file: options.file }, outputOptions(flags.json)),
      );
    });

  const history = program
    .command('history')
    .description("A document's revisions, named versions, and earlier states.");

  history
    .command('list <itemId>')
    .description('List revisions, newest first.')
    .option('--limit <n>', 'maximum revisions in this page (default 50, max 100)', parseInteger)
    .option('--before <seq>', 'page backwards from this sequence number, exclusive', parseInteger)
    .action(
      async (itemId: string, options: { limit?: number; before?: number }, command: Command) => {
        const flags = globalFlags(command);
        await run(() =>
          listHistory(
            flags.profile,
            itemId,
            { limit: options.limit, before: options.before },
            outputOptions(flags.json),
          ),
        );
      },
    );

  history
    .command('show <itemId> <seq>')
    .description('Show the document as it stood at one revision.')
    .option('--markdown', 'render as Markdown instead of plaintext', false)
    .action(
      async (itemId: string, seq: string, options: { markdown?: boolean }, command: Command) => {
        const flags = globalFlags(command);
        await run(() =>
          showHistory(
            flags.profile,
            itemId,
            parseSeqArg(seq),
            { markdown: options.markdown === true },
            outputOptions(flags.json),
          ),
        );
      },
    );

  history
    .command('restore <itemId> <seq>')
    .description('Replace the current document with its state at an earlier revision.')
    .option('--yes', 'confirm this operation', false)
    .action(async (itemId: string, seq: string, options: ConfirmCliOptions, command: Command) => {
      const flags = globalFlags(command);
      await run(() =>
        restoreHistory(
          flags.profile,
          itemId,
          parseSeqArg(seq),
          options.yes === true,
          outputOptions(flags.json),
        ),
      );
    });

  history
    .command('name <itemId> <seq> <name>')
    .description('Name a revision, pinning it so retention can never remove it.')
    .action(
      async (itemId: string, seq: string, name: string, _options: unknown, command: Command) => {
        const flags = globalFlags(command);
        await run(() =>
          nameHistoryVersion(
            flags.profile,
            itemId,
            parseSeqArg(seq),
            name,
            outputOptions(flags.json),
          ),
        );
      },
    );

  history
    .command('versions <itemId>')
    .description("List a document's named versions.")
    .action(async (itemId: string, _options: unknown, command: Command) => {
      const flags = globalFlags(command);
      await run(() => listHistoryVersions(flags.profile, itemId, outputOptions(flags.json)));
    });

  const viewsCmd = program
    .command('views')
    .description('The views a container offers over its children.');

  viewsCmd
    .command('get <itemId>')
    .description("List a container's views, which can render, and which opens by default.")
    .action(async (itemId: string, _options: unknown, command: Command) => {
      const flags = globalFlags(command);
      await run(() => getViews(flags.profile, itemId, outputOptions(flags.json)));
    });

  viewsCmd
    .command('inspect <itemId>')
    .description('Read the saved view configuration, including embedded widgets.')
    .action(async (itemId: string, _options: unknown, command: Command) => {
      const flags = globalFlags(command);
      await run(() => inspectViews(flags.profile, itemId, outputOptions(flags.json)));
    });

  viewsCmd
    .command('set <itemId>')
    .description("Replace a container's view set from a JSON file.")
    .requiredOption('--file <path>', 'a JSON object { "views": [...], "default": <id|null> }')
    .action(async (itemId: string, options: { file: string }, command: Command) => {
      const flags = globalFlags(command);
      await run(() => setViews(flags.profile, itemId, options.file, outputOptions(flags.json)));
    });

  program
    .command('query <itemId>')
    .description("Run one of a container's views and print the children it shows.")
    .requiredOption('--view <viewId>', "which of the container's views to run")
    .requiredOption('--today <yyyy-mm-dd>', "the caller's own day, for relative rules")
    .action(async (itemId: string, options: { view: string; today: string }, command: Command) => {
      const flags = globalFlags(command);
      await run(() =>
        runQuery(
          flags.profile,
          itemId,
          { view: options.view, today: options.today },
          outputOptions(flags.json),
        ),
      );
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
    .description("Replace an item's declared schema from a JSON file.")
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

  const recur = program.command('recur').description("An item's recurrence rule.");

  recur
    .command('set <itemId>')
    .description("Replace an item's recurrence rule wholesale.")
    .requiredOption('--freq <freq>', 'daily | weekly | monthly | yearly')
    .option('--interval <n>', 'repeat every n units of freq (1-366, default 1)')
    .option('--weekdays <days>', 'comma-separated mo,tu,we,th,fr,sa,su - weekly rules only')
    .option('--until <yyyy-mm-dd>', 'the last day the item is due, inclusive (default: no end)')
    .action(
      async (
        itemId: string,
        options: { freq: string; interval?: string; weekdays?: string; until?: string },
        command: Command,
      ) => {
        const flags = globalFlags(command);
        await run(() =>
          setRecurrence(
            flags.profile,
            itemId,
            {
              freq: options.freq,
              interval: options.interval,
              weekdays: options.weekdays,
              until: options.until,
            },
            outputOptions(flags.json),
          ),
        );
      },
    );

  recur
    .command('clear <itemId>')
    .description("Remove an item's recurrence rule; it stops repeating.")
    .action(async (itemId: string, _options: unknown, command: Command) => {
      const flags = globalFlags(command);
      await run(() => clearRecurrence(flags.profile, itemId, outputOptions(flags.json)));
    });

  recur
    .command('complete <itemId>')
    .description('Mark one occurrence of a recurring item complete.')
    .requiredOption('--on <yyyy-mm-dd>', 'the day of the occurrence to complete')
    .action(async (itemId: string, options: { on: string }, command: Command) => {
      const flags = globalFlags(command);
      await run(() =>
        completeRecurrence(flags.profile, itemId, { on: options.on }, outputOptions(flags.json)),
      );
    });

  program
    .command('calendar')
    .description("Print one window of a workspace's collated calendar, generated entries included.")
    .requiredOption('--workspace <id>', 'the workspace to read')
    .requiredOption('--from <yyyy-mm-dd>', 'the first day to include, inclusive')
    .requiredOption('--to <yyyy-mm-dd>', 'the last day to include, inclusive')
    .action(async (options: { workspace: string; from: string; to: string }, command: Command) => {
      const flags = globalFlags(command);
      await run(() =>
        runCalendar(
          flags.profile,
          { workspaceId: options.workspace, from: options.from, to: options.to },
          outputOptions(flags.json),
        ),
      );
    });

  const habit = program.command('habit').description('Configure and record a habit tracker.');

  habit
    .command('set <habitId>')
    .description('Set a habit schedule and target.')
    .requiredOption('--frequency <frequency>', 'daily or weekly')
    .option('--weekdays <days>', 'weekly days as numbers 0 (Sunday) through 6 (Saturday)')
    .requiredOption('--timezone <iana>', 'IANA timezone, for example Europe/London')
    .requiredOption('--start-date <yyyy-mm-dd>', 'first scheduled day')
    .requiredOption('--target <number>', 'target quantity per scheduled day')
    .requiredOption('--unit <unit>', 'unit label, for example minutes or glasses')
    .action(
      async (
        habitId: string,
        options: {
          frequency: string;
          weekdays?: string;
          timezone: string;
          startDate: string;
          target: string;
          unit: string;
        },
        command: Command,
      ) => {
        const flags = globalFlags(command);
        await run(() => setHabit(flags.profile, habitId, options, outputOptions(flags.json)));
      },
    );

  habit
    .command('status <habitId> <status>')
    .description('Set active, paused, or archived; recorded history is retained.')
    .action(async (habitId: string, status: string, _options: unknown, command: Command) => {
      const flags = globalFlags(command);
      await run(() => setHabitStatus(flags.profile, habitId, status, outputOptions(flags.json)));
    });

  habit
    .command('get <habitId>')
    .description('Read habit settings, check-ins, and weekly progress for a date window.')
    .requiredOption('--from <yyyy-mm-dd>', 'first day to include')
    .requiredOption('--to <yyyy-mm-dd>', 'last day to include')
    .action(async (habitId: string, options: { from: string; to: string }, command: Command) => {
      const flags = globalFlags(command);
      await run(() => readHabit(flags.profile, habitId, options, outputOptions(flags.json)));
    });

  habit
    .command('check-in <habitId>')
    .description('Record or update one scheduled day.')
    .requiredOption('--on <yyyy-mm-dd>', 'scheduled day')
    .option('--quantity <number>', 'quantity completed on that day')
    .option('--completed', 'mark the day complete', true)
    .action(
      async (
        habitId: string,
        options: { on: string; quantity?: string; completed: boolean },
        command: Command,
      ) => {
        const flags = globalFlags(command);
        await run(() => checkIn(flags.profile, habitId, options, outputOptions(flags.json)));
      },
    );

  habit
    .command('undo <habitId>')
    .description('Remove the check-in for one scheduled day.')
    .requiredOption('--on <yyyy-mm-dd>', 'scheduled day')
    .action(async (habitId: string, options: { on: string }, command: Command) => {
      const flags = globalFlags(command);
      await run(() => undoCheckIn(flags.profile, habitId, options.on, outputOptions(flags.json)));
    });

  program
    .command('search <query>')
    .description('Full-text search across the items you can see.')
    .option('--limit <n>', 'cap the number of hits', (value) => Number.parseInt(value, 10))
    .action(async (query: string, options: { limit?: number }, command: Command) => {
      const flags = globalFlags(command);
      await run(() =>
        runSearch(flags.profile, query, { limit: options.limit }, outputOptions(flags.json)),
      );
    });

  program
    .command('export <itemId>')
    .description('Create a durable Core export and download its verified result.')
    .option('--format <format>', 'an active worker format (md aliases markdown)', 'nix')
    .option('--scope <scope>', 'item | subtree', 'item')
    .option('-o, --out <file>', 'write the export here instead of stdout')
    .action(
      async (
        itemId: string,
        options: { format: string; scope: string; out?: string },
        command: Command,
      ) => {
        const flags = globalFlags(command);
        await run(() =>
          runExport(
            flags.profile,
            itemId,
            { format: options.format, scope: options.scope, out: options.out },
            outputOptions(flags.json),
          ),
        );
      },
    );

  program
    .command('import <path>')
    .description(
      'Import Markdown trees, PDF, DOCX, or UTF-8 TXT. Documents become editable notes and retain their originals.',
    )
    .requiredOption('--workspace <id>', 'the workspace to import into')
    .option('--parent <id>', 'the container to import under (default: workspace root)')
    .option('--dry-run', 'print the mapping report without creating anything', false)
    .option('--no-wait', 'return a resumable receipt after the preview is queued')
    .action(
      async (path: string, options: ImportCliOptions & { wait?: boolean }, command: Command) => {
        const flags = globalFlags(command);
        await run(() =>
          runImport(
            flags.profile,
            {
              path,
              workspaceId: options.workspace,
              parentId: options.parent,
              dryRun: options.dryRun === true,
              noWait: options.wait === false,
            },
            outputOptions(flags.json),
          ),
        );
      },
    );

  const documentImport = program
    .command('document-import')
    .description('Inspect and resume durable document imports.');
  documentImport
    .command('get <importId>')
    .description('Read durable document import state.')
    .action(async (importId: string, _options: unknown, command: Command) => {
      const flags = globalFlags(command);
      await run(async () => {
        printResult(await getDocumentImport(flags.profile, importId), outputOptions(flags.json));
      });
    });
  documentImport
    .command('commit <importId>')
    .description('Commit a preview-ready document import.')
    .option('--no-wait', 'return a resumable receipt while the import commits')
    .action(async (importId: string, options: { wait?: boolean }, command: Command) => {
      const flags = globalFlags(command);
      await run(async () => {
        printResult(
          await commitDocumentImport(flags.profile, importId, options.wait !== false),
          outputOptions(flags.json),
        );
      });
    });
  documentImport
    .command('cancel <importId>')
    .description('Cancel a durable document import.')
    .option('--yes', 'confirm cancellation of this import', false)
    .action(async (importId: string, options: { yes?: boolean }, command: Command) => {
      const flags = globalFlags(command);
      if (options.yes !== true)
        throw new Error('Pass --yes to confirm cancellation of this import.');
      await run(async () => {
        printResult(await cancelDocumentImport(flags.profile, importId), outputOptions(flags.json));
      });
    });

  const file = program
    .command('file')
    .description('Upload, replace, inspect, and download file items.');
  file
    .command('upload <path>')
    .requiredOption('--workspace <id>', 'the workspace to upload into')
    .option('--parent <id>', 'the parent item')
    .action(
      async (path: string, options: { workspace: string; parent?: string }, command: Command) => {
        const flags = globalFlags(command);
        await run(() =>
          uploadFile(
            flags.profile,
            {
              path,
              workspaceId: options.workspace,
              ...(options.parent === undefined ? {} : { parentId: options.parent }),
            },
            outputOptions(flags.json),
          ),
        );
      },
    );
  file
    .command('replace <itemId> <path>')
    .requiredOption('--workspace <id>', 'the item workspace')
    .action(
      async (itemId: string, path: string, options: { workspace: string }, command: Command) => {
        const flags = globalFlags(command);
        await run(() =>
          uploadFile(
            flags.profile,
            { path, workspaceId: options.workspace, targetItemId: itemId },
            outputOptions(flags.json),
          ),
        );
      },
    );
  file
    .command('versions <itemId>')
    .action(async (itemId: string, _options: unknown, command: Command) => {
      const flags = globalFlags(command);
      await run(() => listFileVersions(flags.profile, itemId, outputOptions(flags.json)));
    });
  file
    .command('download <itemId>')
    .requiredOption('-o, --out <path>', 'output file')
    .option('--version <id>', 'historical version id')
    .action(
      async (itemId: string, options: { out: string; version?: string }, command: Command) => {
        const flags = globalFlags(command);
        await run(() =>
          downloadFile(
            flags.profile,
            itemId,
            options.out,
            options.version,
            outputOptions(flags.json),
          ),
        );
      },
    );

  const stress = program.command('stress').description('Seed and exercise a workspace at scale.');

  stress
    .command('seed')
    .description('Create many children under a container, for the scale the stress rows name.')
    .requiredOption('--workspace <id>', 'the workspace to seed within')
    .requiredOption('--count <n>', 'how many children to create', (value) =>
      Number.parseInt(value, 10),
    )
    .option('--parent <id>', 'the container to seed under (default: create a new one)')
    .option('--title-prefix <p>', 'the prefix each child title carries', 'Item')
    .option('--type <type>', 'the body kind of each child', 'note')
    .option(
      '--prop <key=value...>',
      "a property each child carries; '#n' is the child's index and '#n%<k>' its index modulo k, " +
        'so a seed produces a spread rather than one repeated value',
    )
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
            properties: options.prop,
          },
          outputOptions(flags.json),
        ),
      );
    });

  stress
    .command('run')
    .description('Run a stress scenario and print a machine-readable report.')
    .requiredOption(
      '--scenario <name>',
      'the scenario to run (read-storm, list-storm, chart-storm, search-storm, query-storm)',
    )
    .requiredOption('--iterations <n>', 'how many reads to make', (value) =>
      Number.parseInt(value, 10),
    )
    .option(
      '--item <id>',
      'read-storm/list-storm/chart-storm/query-storm: the item to read (a container for all but ' +
        'read-storm)',
    )
    .option('--workspace <id>', 'list-storm: the workspace the container lives in')
    .option('--page-size <n>', 'list-storm: how many children to ask for per page', (value) =>
      Number.parseInt(value, 10),
    )
    .option('--query <text>', 'search-storm: the query to run each iteration')
    .option('--limit <n>', 'search-storm: cap the hits per query', (value) =>
      Number.parseInt(value, 10),
    )
    .option('--view <viewId>', "query-storm/chart-storm: which of the container's views to run")
    .option('--today <yyyy-mm-dd>', "query-storm: the caller's own day, for relative rules")
    .action(async (options: RunCliOptions, command: Command) => {
      const flags = globalFlags(command);
      await run(() =>
        stressRun(
          flags.profile,
          {
            scenario: options.scenario,
            iterations: options.iterations,
            itemId: options.item,
            workspaceId: options.workspace,
            pageSize: options.pageSize,
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
          {
            workspaceId: options.workspace,
            parentId: options.parent,
            includeDeleted: options.deleted === true,
          },
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
          {
            workspaceId: options.workspace,
            type: options.type,
            title: options.title,
            parentId: options.parent,
          },
          outputOptions(flags.json),
        ),
      );
    });

  item
    .command('edit <itemId>')
    .description('Rename an item.')
    .requiredOption('--workspace <id>', "the item's workspace")
    .requiredOption('--title <title>', 'the new title')
    .action(
      async (itemId: string, options: { workspace: string; title: string }, command: Command) => {
        const flags = globalFlags(command);
        await run(() =>
          renameItem(
            flags.profile,
            itemId,
            options.workspace,
            options.title,
            outputOptions(flags.json),
          ),
        );
      },
    );

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
          {
            workspaceId: options.workspace,
            parentId: options.parent ?? null,
            afterId: options.after ?? null,
          },
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
      await run(() =>
        deleteItem(flags.profile, itemId, options.workspace, outputOptions(flags.json)),
      );
    });

  item
    .command('restore <itemId>')
    .description('Restore a soft-deleted item.')
    .requiredOption('--workspace <id>', "the item's workspace")
    .action(async (itemId: string, options: WorkspaceOption, command: Command) => {
      const flags = globalFlags(command);
      await run(() =>
        restoreItem(flags.profile, itemId, options.workspace, outputOptions(flags.json)),
      );
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

interface PageCliOptions {
  readonly limit?: number;
  readonly cursor?: string;
}

interface ConfirmCliOptions {
  readonly yes?: boolean;
}

function parseInteger(value: string): number {
  return Number.parseInt(value, 10);
}

/** Parses a `<seq>` positional argument; a history `seq` is always a non-negative integer. */
function parseSeqArg(value: string): number {
  const seq = Number.parseInt(value, 10);
  if (!Number.isInteger(seq) || seq < 0 || String(seq) !== value) {
    throw new Error(`'${value}' is not a valid sequence number.`);
  }
  return seq;
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseTemplateInputPairs(entries: readonly string[]): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator < 1) {
      throw new Error(`Template input '${entry}' must use key=value syntax.`);
    }
    const key = entry.slice(0, separator);
    if (Object.hasOwn(values, key)) {
      throw new Error(`Template input '${key}' was supplied more than once.`);
    }
    values[key] = entry.slice(separator + 1);
  }
  if (Object.keys(values).length > 100) {
    throw new Error('A template accepts at most 100 inputs.');
  }
  return values;
}

interface ImportCliOptions {
  readonly workspace: string;
  readonly parent?: string;
  readonly dryRun?: boolean;
}

interface SeedCliOptions {
  readonly workspace: string;
  readonly count: number;
  readonly parent?: string;
  readonly titlePrefix?: string;
  readonly type?: string;
  readonly prop?: readonly string[];
}

interface RunCliOptions {
  readonly scenario: string;
  readonly iterations: number;
  readonly item?: string;
  readonly workspace?: string;
  readonly pageSize?: number;
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
