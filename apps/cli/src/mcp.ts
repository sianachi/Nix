/** Workspace administration tools exposed over the Model Context Protocol. */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  files,
  habits,
  operations,
  workspaces,
  templates as templateResources,
  templateInitializationSchema,
} from '@nix/api-client';
import { downloadFileValue, uploadFileValue } from './commands/files.ts';
import { runImport } from './commands/import.ts';
import {
  cancelDocumentImportFromSession,
  commitDocumentImportFromSession,
  getDocumentImportFromSession,
} from './commands/document-import.ts';
import {
  executeTemplateApply,
  executeTemplateArchiveCommit,
  executeTemplateArchiveExport,
  executeTemplateImportGet,
  executeTemplateImportCancel,
  executeTemplateArchivePreview,
  executeTemplateCapture,
  executeTemplateDraftBegin,
  executeTemplateDraftGet,
  executeTemplateDraftUpdate,
  executeTemplateDraftItemUpdate,
  executeTemplateDraftSave,
  executeTemplateDraftDiscard,
  executeTemplateOperationResume,
  executeTemplateInitializationUpdate,
} from './commands/templates.ts';
import { resolveSession, type SessionDeps } from './commands/shared.ts';
import type { Session } from './session.ts';

const identifier = z.uuid();
const workspaceRole = z.enum(['owner', 'editor', 'viewer']);
const pageInput = {
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
};

export interface WorkspaceMcpOptions {
  readonly profileName?: string;
  readonly sessionDeps?: SessionDeps;
  readonly resolve?: (profileName: string | undefined, deps: SessionDeps) => Promise<Session>;
}

/** Creates the MCP server without binding a transport, so protocol tests can use an in-memory pair. */
export async function createWorkspaceMcpServer(
  options: WorkspaceMcpOptions = {},
): Promise<McpServer> {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const server = new McpServer({ name: 'nixctl', version: '0.0.0' });
  const resolver = options.resolve ?? resolveSession;
  const session = lazy(() => resolver(options.profileName, options.sessionDeps ?? {}));

  server.registerTool(
    'begin_template_draft',
    {
      description:
        'Copy a template into an editable draft, waiting for file copies to finish before returning.',
      inputSchema: {
        templateId: identifier,
        idempotencyKey: z.string().min(1).max(200).optional(),
      },
    },
    ({ templateId, idempotencyKey }) =>
      toolResult(async () => {
        const current = await session();
        const key = idempotencyKey ?? `nixctl-mcp-draft:${templateId}:${randomUUID()}`;
        const draft = await executeTemplateDraftBegin(current, templateId, key, false);
        return {
          draft,
          resume: draft.fileTransferPending
            ? {
                kind: 'draft',
                jobId: draft.fileTransferJobId,
                operationId: draft.operationId,
                idempotencyKey: key,
                request: { templateId, idempotencyKey: key },
              }
            : { idempotencyKey: key },
        };
      }),
  );

  server.registerTool(
    'get_template_draft',
    {
      description: 'Read an active template draft and its item tree.',
      inputSchema: { templateId: identifier, operationId: identifier },
    },
    ({ templateId, operationId }) =>
      toolResult(async () => executeTemplateDraftGet(await session(), templateId, operationId)),
  );

  server.registerTool(
    'update_template_draft',
    {
      description: 'Update a draft title, description, or setup questions and rules.',
      inputSchema: {
        templateId: identifier,
        operationId: identifier,
        title: z.string().trim().min(1).max(200).optional(),
        description: z.string().max(4_096).nullable().optional(),
        initialization: z.record(z.string(), z.unknown()).optional(),
      },
    },
    ({ templateId, operationId, title, description, initialization }) =>
      toolResult(async () =>
        executeTemplateDraftUpdate(await session(), templateId, operationId, {
          ...(title === undefined ? {} : { title }),
          ...(description === undefined ? {} : { description }),
          ...(initialization === undefined
            ? {}
            : { initialization: templateInitializationSchema.parse(initialization) }),
        }),
      ),
  );

  server.registerTool(
    'update_template_draft_item',
    {
      description: 'Update a draft item title, properties, schema, or views.',
      inputSchema: {
        templateId: identifier,
        operationId: identifier,
        sourceId: identifier,
        title: z.string().trim().min(1).max(200).optional(),
        properties: z.record(z.string(), z.unknown()).nullable().optional(),
        schema: z
          .object({ properties: z.array(z.unknown()), inherit: z.boolean() })
          .nullable()
          .optional(),
        views: z.unknown().optional(),
      },
    },
    ({ templateId, operationId, sourceId, title, properties, schema, views }) =>
      toolResult(async () =>
        executeTemplateDraftItemUpdate(await session(), templateId, operationId, sourceId, {
          ...(title === undefined ? {} : { title }),
          ...(properties === undefined ? {} : { properties }),
          ...(schema === undefined ? {} : { schema }),
          ...(views === undefined ? {} : { views }),
        }),
      ),
  );

  server.registerTool(
    'save_template_draft',
    {
      description: 'Publish a completed template draft as a new revision.',
      inputSchema: { templateId: identifier, operationId: identifier },
    },
    ({ templateId, operationId }) =>
      toolResult(async () => executeTemplateDraftSave(await session(), templateId, operationId)),
  );

  server.registerTool(
    'discard_template_draft',
    {
      description: 'Discard an unfinished template draft.',
      inputSchema: { templateId: identifier, operationId: identifier },
    },
    ({ templateId, operationId }) =>
      toolResult(async () => executeTemplateDraftDiscard(await session(), templateId, operationId)),
  );

  server.registerTool(
    'list_workspaces',
    {
      description: 'List one bounded page of Nix workspaces reachable by the current principal.',
      inputSchema: pageInput,
    },
    ({ limit, cursor }) =>
      toolResult(async () =>
        (await session()).client.query(
          workspaces.listWorkspacesPage({ limit, ...(cursor === undefined ? {} : { cursor }) }),
        ),
      ),
  );

  server.registerTool(
    'create_workspace',
    {
      description: 'Create a shared Nix workspace owned by the current principal.',
      inputSchema: { name: z.string().trim().min(1).max(200) },
    },
    ({ name }) =>
      toolResult(async () => (await session()).client.execute(workspaces.createWorkspace(name))),
  );

  server.registerTool(
    'rename_workspace',
    {
      description: 'Rename a workspace when the server grants that capability.',
      inputSchema: { workspaceId: identifier, name: z.string().trim().min(1).max(200) },
    },
    ({ workspaceId, name }) =>
      toolResult(async () =>
        (await session()).client.execute(workspaces.renameWorkspace(workspaceId, name)),
      ),
  );

  server.registerTool(
    'list_workspace_invitations',
    {
      description: 'List invitation history for a workspace.',
      inputSchema: { workspaceId: identifier, ...pageInput },
    },
    ({ workspaceId, limit, cursor }) =>
      toolResult(async () =>
        (await session()).client.query(
          workspaces.listInvitationsPage(workspaceId, {
            limit,
            ...(cursor === undefined ? {} : { cursor }),
          }),
        ),
      ),
  );

  server.registerTool(
    'list_workspace_invitees',
    {
      description: 'List active Nix users who can be invited to a workspace.',
      inputSchema: { workspaceId: identifier, ...pageInput },
    },
    ({ workspaceId, limit, cursor }) =>
      toolResult(async () =>
        (await session()).client.query(
          workspaces.listInviteesPage(workspaceId, {
            limit,
            ...(cursor === undefined ? {} : { cursor }),
          }),
        ),
      ),
  );

  server.registerTool(
    'invite_workspace_member',
    {
      description: 'Grant an existing Nix user provisional access as an owner, editor, or viewer.',
      inputSchema: {
        workspaceId: identifier,
        principalId: identifier,
        role: workspaceRole,
      },
    },
    ({ workspaceId, principalId, role }) =>
      toolResult(async () =>
        (await session()).client.execute(
          workspaces.createInvitation(workspaceId, principalId, role),
        ),
      ),
  );

  server.registerTool(
    'accept_workspace_invitation',
    {
      description: 'Accept a workspace invitation addressed to the current principal.',
      inputSchema: { workspaceId: identifier, invitationId: identifier },
    },
    ({ workspaceId, invitationId }) =>
      toolResult(async () => {
        await (
          await session()
        ).client.execute(workspaces.acceptInvitation(workspaceId, invitationId));
        return { accepted: true, invitationId };
      }),
  );

  server.registerTool(
    'decline_workspace_invitation',
    {
      description: 'Decline a workspace invitation and remove provisional access.',
      inputSchema: { workspaceId: identifier, invitationId: identifier, confirm: z.literal(true) },
    },
    ({ workspaceId, invitationId }) =>
      toolResult(async () => {
        await (
          await session()
        ).client.execute(workspaces.declineInvitation(workspaceId, invitationId));
        return { declined: true, invitationId };
      }),
  );

  server.registerTool(
    'revoke_workspace_invitation',
    {
      description: 'Revoke a pending workspace invitation.',
      inputSchema: { workspaceId: identifier, invitationId: identifier, confirm: z.literal(true) },
    },
    ({ workspaceId, invitationId }) =>
      toolResult(async () => {
        await (
          await session()
        ).client.execute(workspaces.revokeInvitation(workspaceId, invitationId));
        return { revoked: true, invitationId };
      }),
  );

  server.registerTool(
    'get_operation',
    {
      description: 'Read the current state of an operation visible to the current principal.',
      inputSchema: { operationId: identifier },
    },
    ({ operationId }) =>
      toolResult(async () =>
        (await session()).client.query(operations.operationById(operationId), {
          forceRefresh: true,
        }),
      ),
  );

  server.registerTool(
    'cancel_template_archive_import',
    {
      description: 'Cancel a template archive import visible to the current principal.',
      inputSchema: { importId: identifier, confirm: z.literal(true) },
    },
    ({ importId }) =>
      toolResult(async () => executeTemplateImportCancel(await session(), importId)),
  );

  server.registerTool(
    'list_workspace_members',
    {
      description: 'List principal and group workspace grants with server-decided capabilities.',
      inputSchema: { workspaceId: identifier, ...pageInput },
    },
    ({ workspaceId, limit, cursor }) =>
      toolResult(async () =>
        (await session()).client.query(
          workspaces.listMembersPage(workspaceId, {
            limit,
            ...(cursor === undefined ? {} : { cursor }),
          }),
        ),
      ),
  );

  server.registerTool(
    'set_habit',
    {
      description: 'Set a habit schedule and target for an item the current principal may edit.',
      inputSchema: {
        habitId: identifier,
        frequency: z.enum(['daily', 'weekly']),
        weekdays: z.array(z.number().int().min(0).max(6)).default([]),
        timezone: z.string().trim().min(1),
        startDate: z.iso.date(),
        target: z.number().positive(),
        unit: z.string().trim().min(1),
      },
    },
    ({ habitId, frequency, weekdays, timezone, startDate, target, unit }) =>
      toolResult(async () =>
        (await session()).client.execute(
          habits.setHabit(habitId, { frequency, weekdays, timezone, startDate, target, unit }),
        ),
      ),
  );

  server.registerTool(
    'set_habit_status',
    {
      description: 'Pause, resume, archive, or restore a habit while retaining its history.',
      inputSchema: { habitId: identifier, status: z.enum(['active', 'paused', 'archived']) },
    },
    ({ habitId, status }) =>
      toolResult(async () =>
        (await session()).client.execute(habits.setStatus(habitId, { status })),
      ),
  );

  server.registerTool(
    'read_habit',
    {
      description: 'Read habit settings, check-ins, and weekly progress for a date window.',
      inputSchema: {
        habitId: identifier,
        from: z.iso.date(),
        to: z.iso.date(),
      },
    },
    ({ habitId, from, to }) =>
      toolResult(async () => (await session()).client.query(habits.readHabit(habitId, from, to))),
  );

  server.registerTool(
    'check_in_habit',
    {
      description: 'Record or update one scheduled day for a habit.',
      inputSchema: {
        habitId: identifier,
        occurredOn: z.iso.date(),
        completed: z.boolean().default(true),
        quantity: z.number().min(0).nullable().default(null),
      },
    },
    ({ habitId, occurredOn, completed, quantity }) =>
      toolResult(async () =>
        (await session()).client.execute(
          habits.checkIn(habitId, occurredOn, { completed, quantity }),
        ),
      ),
  );

  server.registerTool(
    'undo_habit_check_in',
    {
      description: 'Remove the check-in for one scheduled day.',
      inputSchema: { habitId: identifier, occurredOn: z.iso.date() },
    },
    ({ habitId, occurredOn }) =>
      toolResult(async () =>
        (await session()).client.execute(habits.undoCheckIn(habitId, occurredOn)),
      ),
  );

  server.registerTool(
    'change_workspace_member_role',
    {
      description: "Change a principal's direct membership role when permitted by the server.",
      inputSchema: { workspaceId: identifier, principalId: identifier, role: workspaceRole },
    },
    ({ workspaceId, principalId, role }) =>
      toolResult(async () =>
        (await session()).client.execute(
          workspaces.changeMemberRole(workspaceId, principalId, role),
        ),
      ),
  );

  server.registerTool(
    'remove_workspace_member',
    {
      description: "Remove a principal's direct membership when permitted by the server.",
      inputSchema: { workspaceId: identifier, principalId: identifier, confirm: z.literal(true) },
    },
    ({ workspaceId, principalId }) =>
      toolResult(async () => {
        await (await session()).client.execute(workspaces.removeMember(workspaceId, principalId));
        return { removed: true, principalId };
      }),
  );

  server.registerTool(
    'list_workspace_assignable_principals',
    {
      description:
        'List active direct and group-derived workspace principals available for assignment.',
      inputSchema: {
        workspaceId: identifier,
        query: z.string().trim().max(128).optional(),
        limit: z.number().int().min(1).max(100).default(50),
        cursor: z.string().max(128).optional(),
      },
    },
    ({ workspaceId, query, limit, cursor }) =>
      toolResult(async () =>
        (await session()).client.query(
          workspaces.listAssignablePrincipalsPage(workspaceId, {
            ...(query === undefined ? {} : { query }),
            limit,
            ...(cursor === undefined ? {} : { cursor }),
          }),
        ),
      ),
  );

  server.registerTool(
    'leave_workspace',
    {
      description: 'Leave a workspace when doing so preserves ownership.',
      inputSchema: { workspaceId: identifier, confirm: z.literal(true) },
    },
    ({ workspaceId }) =>
      toolResult(async () => {
        await (await session()).client.execute(workspaces.leaveWorkspace(workspaceId));
        return { left: true, workspaceId };
      }),
  );

  server.registerTool(
    'import_document',
    {
      description:
        'Import a local PDF, DOCX, UTF-8 TXT, Markdown file, or Markdown folder as editable Nix notes.',
      inputSchema: {
        workspaceId: identifier,
        path: z.string().min(1),
        parentId: identifier.optional(),
        preview: z.boolean().default(false),
        wait: z.boolean().default(true),
      },
    },
    ({ workspaceId, path, parentId, preview, wait }) =>
      toolResult(async () => {
        let result: unknown;
        await runImport(
          options.profileName,
          {
            workspaceId,
            path,
            dryRun: preview,
            noWait: !wait,
            ...(parentId === undefined ? {} : { parentId }),
          },
          { json: true, isTty: false },
          options.sessionDeps ?? {},
          {
            writeResult: (value) => {
              result = value;
            },
            setExitCode: false,
            onDocumentImportStarted: () => undefined,
          },
        );
        return result;
      }),
  );

  server.registerTool(
    'get_document_import',
    {
      description: 'Read durable state for a document import.',
      inputSchema: { importId: identifier },
    },
    ({ importId }) =>
      toolResult(async () => getDocumentImportFromSession(await session(), importId)),
  );

  server.registerTool(
    'commit_document_import',
    {
      description:
        'Commit a preview-ready document import, optionally returning before completion.',
      inputSchema: { importId: identifier, wait: z.boolean().default(true) },
    },
    ({ importId, wait }) =>
      toolResult(async () => commitDocumentImportFromSession(await session(), importId, wait)),
  );

  server.registerTool(
    'cancel_document_import',
    {
      description: 'Cancel a document import after explicit confirmation.',
      inputSchema: { importId: identifier, confirm: z.literal(true) },
    },
    ({ importId }) =>
      toolResult(async () => cancelDocumentImportFromSession(await session(), importId)),
  );

  server.registerTool(
    'upload_file',
    {
      description:
        'Upload a local file as an opaque child item. Uploaded files are not malware-scanned.',
      inputSchema: {
        workspaceId: identifier,
        path: z.string().min(1),
        parentId: identifier.optional(),
      },
    },
    ({ workspaceId, path, parentId }) =>
      toolResult(() =>
        uploadFileValue(
          options.profileName,
          { workspaceId, path, ...(parentId === undefined ? {} : { parentId }) },
          options.sessionDeps ?? {},
        ),
      ),
  );

  server.registerTool(
    'replace_file',
    {
      description: 'Upload a new immutable current version for an existing file item.',
      inputSchema: { workspaceId: identifier, itemId: identifier, path: z.string().min(1) },
    },
    ({ workspaceId, itemId, path }) =>
      toolResult(() =>
        uploadFileValue(
          options.profileName,
          { workspaceId, path, targetItemId: itemId },
          options.sessionDeps ?? {},
        ),
      ),
  );

  server.registerTool(
    'list_file_versions',
    {
      description: 'List file metadata and immutable versions for a visible file item.',
      inputSchema: { itemId: identifier },
    },
    ({ itemId }) =>
      toolResult(async () => (await session()).client.query(files.fileByItem(itemId))),
  );

  server.registerTool(
    'download_file',
    {
      description: 'Download a current or historical file version to a local path.',
      inputSchema: {
        itemId: identifier,
        outputPath: z.string().min(1),
        versionId: identifier.optional(),
      },
    },
    ({ itemId, outputPath, versionId }) =>
      toolResult(() =>
        downloadFileValue(
          options.profileName,
          itemId,
          outputPath,
          versionId,
          options.sessionDeps ?? {},
        ),
      ),
  );

  server.registerTool(
    'list_templates',
    {
      description: 'List templates visible in a workspace, including their setup metadata.',
      inputSchema: { workspaceId: identifier },
    },
    ({ workspaceId }) =>
      toolResult(async () =>
        (await session()).client.query(templateResources.listTemplates(workspaceId)),
      ),
  );

  server.registerTool(
    'get_template',
    {
      description: 'Read a template, its item tree, and its initialization questions and rules.',
      inputSchema: { templateId: identifier },
    },
    ({ templateId }) =>
      toolResult(async () =>
        (await session()).client.query(templateResources.templateById(templateId)),
      ),
  );

  server.registerTool(
    'capture_template',
    {
      description: 'Capture a readable item subtree as a reusable workspace template.',
      inputSchema: {
        workspaceId: identifier,
        sourceItemId: identifier,
        title: z.string().trim().min(1).max(200),
        description: z.string().max(4_096).nullable().optional(),
        includeBody: z.boolean().default(false),
        includeChildren: z.boolean().default(false),
        idempotencyKey: z.string().min(1).max(200).optional(),
      },
    },
    ({
      workspaceId,
      sourceItemId,
      title,
      description,
      includeBody,
      includeChildren,
      idempotencyKey,
    }) =>
      toolResult(async () => {
        const key = idempotencyKey ?? `nixctl-mcp-capture:${sourceItemId}:${randomUUID()}`;
        const request = {
          workspaceId,
          sourceItemId,
          title,
          ...(description === undefined ? {} : { description }),
          includeBody,
          includeChildren,
          idempotencyKey: key,
        };
        const result = await executeTemplateCapture(await session(), request, false);
        return {
          capture: result,
          resume: result.fileTransferPending
            ? {
                kind: 'capture',
                jobId: result.fileTransferJobId,
                operationId: result.operationId,
                idempotencyKey: key,
                request,
              }
            : { idempotencyKey: key, request },
        };
      }),
  );

  server.registerTool(
    'preflight_template_application',
    {
      description:
        'Resolve inputs and preview a template against an exact destination and revision.',
      inputSchema: {
        templateId: identifier,
        mode: z.enum(['merge', 'create']),
        targetItemId: identifier.nullable().optional(),
        parentItemId: identifier.nullable().optional(),
        title: z.string().max(200).optional(),
        inputs: z.record(z.string(), z.string()).optional(),
        expectedRevision: z.number().int().nonnegative().optional(),
      },
    },
    ({ templateId, mode, targetItemId, parentItemId, title, inputs, expectedRevision }) =>
      toolResult(async () => {
        const current = await session();
        const detail = await current.client.query(templateResources.templateById(templateId));
        return current.client.execute(
          templateResources.preflightTemplate(templateId, {
            mode,
            ...(targetItemId === undefined ? {} : { targetItemId }),
            ...(parentItemId === undefined ? {} : { parentItemId }),
            ...(title === undefined ? {} : { title }),
            ...(inputs === undefined ? {} : { inputs }),
            expectedRevision: expectedRevision ?? detail.revision,
          }),
        );
      }),
  );

  server.registerTool(
    'apply_template',
    {
      description:
        'Preflight and apply a template; the server checks permissions and resolves links.',
      inputSchema: {
        templateId: identifier,
        mode: z.enum(['merge', 'create']),
        targetItemId: identifier.nullable().optional(),
        parentItemId: identifier.nullable().optional(),
        title: z.string().max(200).optional(),
        inputs: z.record(z.string(), z.string()).optional(),
        expectedRevision: z.number().int().nonnegative().optional(),
        idempotencyKey: z.string().min(1).max(200).optional(),
      },
    },
    ({
      templateId,
      mode,
      targetItemId,
      parentItemId,
      title,
      inputs,
      expectedRevision,
      idempotencyKey,
    }) =>
      toolResult(async () =>
        executeTemplateApply(
          await session(),
          {
            templateId,
            mode,
            ...(targetItemId === undefined ? {} : { targetItemId }),
            ...(parentItemId === undefined ? {} : { parentItemId }),
            ...(title === undefined ? {} : { title }),
            ...(inputs === undefined ? {} : { inputs }),
            ...(expectedRevision === undefined ? {} : { expectedRevision }),
            ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          },
          randomUUID,
          { waitForFileTransfer: false },
        ),
      ),
  );

  server.registerTool(
    'set_template_initialization',
    {
      description:
        'Author setup questions, per-field rules, and external reference policies, then save the template draft.',
      inputSchema: {
        templateId: identifier,
        initialization: z.record(z.string(), z.unknown()),
        title: z.string().trim().min(1).max(200).optional(),
        description: z.string().max(4_096).nullable().optional(),
        idempotencyKey: z.string().min(1).max(200).optional(),
      },
    },
    ({ templateId, initialization, title, description, idempotencyKey }) =>
      toolResult(async () => {
        const parsed = templateInitializationSchema.parse(initialization);
        const key = idempotencyKey ?? `nixctl-mcp-edit:${templateId}:${randomUUID()}`;
        return executeTemplateInitializationUpdate(
          await session(),
          templateId,
          parsed,
          {
            ...(title === undefined ? {} : { title }),
            ...(description === undefined ? {} : { description }),
            idempotencyKey: key,
          },
          randomUUID,
          false,
        );
      }),
  );

  server.registerTool(
    'preview_template_archive_import',
    {
      description:
        'Upload a local .nix template archive and validate its destination and digest before commit.',
      inputSchema: {
        workspaceId: identifier,
        path: z.string().trim().min(1).max(4_096),
        idempotencyKey: z.string().min(1).max(200).optional(),
      },
    },
    ({ workspaceId, path, idempotencyKey }) =>
      toolResult(async () => {
        const key = idempotencyKey ?? `nixctl-mcp-template-import:${randomUUID()}`;
        return executeTemplateArchivePreview(await session(), workspaceId, path, key);
      }),
  );

  server.registerTool(
    'get_template_archive_import',
    {
      description: 'Read the current state of an authorized template archive import.',
      inputSchema: { importId: identifier },
    },
    ({ importId }) => toolResult(async () => executeTemplateImportGet(await session(), importId)),
  );

  server.registerTool(
    'commit_template_archive_import',
    {
      description:
        'Publish a previewed template archive using its exact import ID and SHA-256 digest.',
      inputSchema: {
        importId: identifier,
        digest: z.string().regex(/^[0-9a-f]{64}$/),
      },
    },
    ({ importId, digest }) =>
      toolResult(async () => executeTemplateArchiveCommit(await session(), importId, digest)),
  );

  server.registerTool(
    'export_template_archive',
    {
      description:
        'Write a portable template archive to a local path and return its size and media type.',
      inputSchema: {
        templateId: identifier,
        path: z.string().trim().min(1).max(4_096),
      },
    },
    ({ templateId, path }) =>
      toolResult(async () => executeTemplateArchiveExport(await session(), templateId, path)),
  );

  server.registerTool(
    'resume_template_file_copy',
    {
      description:
        'Wait for a Core file-copy operation, then replay the original idempotent template command.',
      inputSchema: {
        kind: z.enum(['capture', 'apply', 'draft']),
        jobId: identifier,
        request: z.record(z.string(), z.unknown()),
      },
    },
    ({ kind, jobId, request }) =>
      toolResult(async () =>
        executeTemplateOperationResume(await session(), { kind, jobId, request }),
      ),
  );

  return server;
}

/** Runs `nixctl mcp` on stdio. Protocol messages are the only bytes written to stdout. */
export async function runWorkspaceMcpServer(profileName: string | undefined): Promise<void> {
  const server = await createWorkspaceMcpServer(profileName === undefined ? {} : { profileName });
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  await server.connect(new StdioServerTransport());
}

function lazy<T>(factory: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => {
    value ??= factory();
    return value;
  };
}

async function toolResult(action: () => Promise<unknown>) {
  try {
    const result = await action();
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: error instanceof Error ? error.message : 'The Nix operation failed.',
        },
      ],
    };
  }
}
