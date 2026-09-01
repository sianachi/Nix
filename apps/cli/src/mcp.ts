/** Workspace administration tools exposed over the Model Context Protocol. */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { files, workspaces } from '@nix/api-client';
import { downloadFileValue, uploadFileValue } from './commands/files.ts';
import { runImport } from './commands/import.ts';
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
      },
    },
    ({ workspaceId, path, parentId, preview }) =>
      toolResult(async () => {
        let result: unknown;
        await runImport(
          options.profileName,
          { workspaceId, path, dryRun: preview, ...(parentId === undefined ? {} : { parentId }) },
          { json: true, isTty: false },
          options.sessionDeps ?? {},
          {
            writeResult: (value) => {
              result = value;
            },
            setExitCode: false,
          },
        );
        return result;
      }),
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
