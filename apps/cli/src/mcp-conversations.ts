import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { createConversationInputSchema } from '@nix/api-client';
import type { Session } from './session.ts';
import {
  executeCreateConversation,
  executeConfigureConversation,
  executeGetConversation,
  executeConversationMessages,
  executeSendConversation,
  executeWatchConversation,
  executeCancelConversation,
  executeConversationSources,
} from './commands/conversations.ts';

export function registerConversationMcpTools(
  server: McpServer,
  session: () => Promise<Session>,
  result: (action: () => Promise<unknown>) => Promise<CallToolResult>,
): void {
  const itemInput = { itemId: z.uuid() };
  for (const importing of [false, true]) {
    server.registerTool(
      importing ? 'import_chat_note' : 'create_chat_note',
      {
        description: importing
          ? 'Save a retained visible transcript as a durable chat note. Explicitly confirm sharing with destination readers. Does not copy hidden provider context.'
          : 'Create a durable chat note for read-only analysis of the selected source workspaces. Source access is checked by Core.',
        inputSchema: {
          workspaceId: z.uuid(),
          conversation: createConversationInputSchema,
          confirmSharing: z.boolean().default(false),
        },
      },
      ({ workspaceId, conversation, confirmSharing }) =>
        result(async () => {
          if ((conversation.messages?.length ?? 0) > 0 && !confirmSharing)
            throw new Error(
              'Inspect the destination visibility and confirm sharing the transcript with its readers.',
            );
          if (importing && !conversation.messages?.length)
            throw new Error('Import needs a non-empty messages transcript.');
          return executeCreateConversation(await session(), workspaceId, conversation, importing);
        }),
    );
  }
  server.registerTool(
    'get_chat_note',
    {
      description: 'Read chat-note scope, permission to send and active turn.',
      inputSchema: itemInput,
    },
    ({ itemId }) => result(async () => executeGetConversation(await session(), itemId)),
  );
  server.registerTool(
    'read_chat_messages',
    {
      description: 'Read a page of saved chat messages. Pass nextCursor to continue.',
      inputSchema: {
        ...itemInput,
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(50),
      },
    },
    ({ itemId, cursor, limit }) =>
      result(async () =>
        executeConversationMessages(await session(), itemId, {
          limit,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      ),
  );
  server.registerTool(
    'send_chat_message',
    {
      description:
        'Start one read-only analysis turn as the current sender using their provider account. Reuse requestId when retrying the same message.',
      inputSchema: {
        ...itemInput,
        requestId: z.uuid(),
        text: z.string().trim().min(1),
        model: z.string().optional(),
      },
    },
    ({ itemId, requestId, text, model }) =>
      result(async () =>
        executeSendConversation(await session(), itemId, {
          requestId,
          text,
          ...(model === undefined ? {} : { model }),
        }),
      ),
  );
  server.registerTool(
    'watch_chat_note',
    {
      description:
        'Read a fresh chat revision snapshot. Poll with the returned revision to follow streaming progress.',
      inputSchema: { ...itemInput, after: z.number().int().nonnegative().default(0) },
    },
    ({ itemId, after }) =>
      result(async () => executeWatchConversation(await session(), itemId, after)),
  );
  server.registerTool(
    'cancel_chat_turn',
    {
      description: 'Cancel an active chat turn and keep the saved transcript.',
      inputSchema: itemInput,
    },
    ({ itemId }) => result(async () => executeCancelConversation(await session(), itemId)),
  );
  server.registerTool(
    'configure_chat_note',
    {
      description:
        'Configure a compatible existing note as a durable chat using explicit source workspaces and pet. Core validates message fields and permissions.',
      inputSchema: { ...itemInput, sourceWorkspaceIds: z.array(z.uuid()).min(1), petId: z.uuid() },
    },
    ({ itemId, sourceWorkspaceIds, petId }) =>
      result(async () =>
        executeConfigureConversation(await session(), itemId, { sourceWorkspaceIds, petId }),
      ),
  );
  server.registerTool(
    'set_chat_sources',
    {
      description:
        'Replace source workspace scope for future turns. Group membership never silently expands this scope.',
      inputSchema: {
        ...itemInput,
        sourceWorkspaceIds: z.array(z.uuid()).min(1),
        expectedRevision: z.number().int().nonnegative(),
      },
    },
    ({ itemId, sourceWorkspaceIds, expectedRevision }) =>
      result(async () =>
        executeConversationSources(await session(), itemId, sourceWorkspaceIds, expectedRevision),
      ),
  );
}
