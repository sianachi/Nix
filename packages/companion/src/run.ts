import { z } from 'zod';
import { items, search, structure } from '@nix/api-client';
import type { CompanionPorts } from './ports.js';
import { READ_ONLY_OPERATIONS, WorkspaceToolRefusal, workspaceToolSchema } from './tool-args.js';

export { WorkspaceToolRefusal } from './tool-args.js';

export interface RunOptions {
  mode?: 'chat' | 'consult';
  toolId?: string;
  claimId?: string;
}

export interface WorkspaceToolOutcome {
  text: string;
  readOnly: boolean;
  touchedParents: (string | null)[];
}

/** Execute only after the caller claims and approves this exact tool request. */
export async function runWorkspaceTool(
  ports: CompanionPorts,
  workspaceId: string,
  raw: string,
  signal: AbortSignal,
  options: RunOptions = {},
): Promise<WorkspaceToolOutcome> {
  // Reserved for a later phase (blueprint building and consult mode read this
  // executor's mode/toolId/claimId); this pure move does not yet consume it.
  void options;
  const client = ports.core;
  const bodies = ports.bodies;
  if (raw.length > 40000) throw new Error('Tool arguments are too large.');
  const args = workspaceToolSchema.parse(JSON.parse(raw));
  const requestOptions = { signal, forceRefresh: true };
  const check = async (id: string) => {
    if (!id) throw new Error('An item identity is required.');
    const item = await client.query(items.itemById(id), requestOptions);
    if (item.workspaceId !== workspaceId)
      throw new WorkspaceToolRefusal('The item is outside this workspace. No action was run.');
    return item;
  };
  // Scope guards supplement, never replace, permission checks in Core and collab.
  if (args.parentId) await check(args.parentId);
  let result: unknown;
  switch (args.operation) {
    case 'restore_item': {
      // Ordinary item reads intentionally hide deleted rows. Establish the exact
      // target through Core's workspace-scoped trash query before restoring it.
      let found = false;
      let checked = 0;
      for await (const item of client.paginate(items.listTrash(workspaceId, 50), requestOptions)) {
        if (++checked > 500) break;
        if (item.id === args.itemId && item.workspaceId === workspaceId) {
          found = true;
          break;
        }
      }
      if (!found)
        throw new WorkspaceToolRefusal(
          'The item was not found in this workspace’s first 500 trash entries. No restore was attempted.',
        );
      result = await client.execute(items.restoreItem(workspaceId, args.itemId), requestOptions);
      break;
    }
    case 'list_items': {
      const rows = [];
      let truncated = false;
      for await (const item of client.paginate(
        items.listItems(workspaceId, { parentId: args.parentId || undefined, pageSize: 50 }),
        requestOptions,
      )) {
        if (rows.length >= 50) {
          truncated = true;
          break;
        }
        rows.push({
          id: item.id,
          title: item.title,
          type: item.type,
          hasChildren: item.hasChildren,
        });
      }
      result = { items: rows, truncated };
      break;
    }
    case 'search': {
      if (!args.query.trim()) throw new Error('A search query is required.');
      if (z.uuid().safeParse(args.query.trim()).success) {
        const item = await check(args.query.trim());
        result = {
          results: [
            { id: item.id, workspaceId: item.workspaceId, title: item.title, type: item.type },
          ],
          truncated: false,
        };
        break;
      }
      const found = await client.query(search.searchItems(args.query, 50), requestOptions);
      result = {
        results: found.results.filter((item) => item.workspaceId === workspaceId),
        truncated: found.truncated,
      };
      break;
    }
    case 'create_note': {
      if (!args.title.trim()) throw new Error('A title is required.');
      const item = await client.execute(
        items.createItem(workspaceId, {
          type: 'note',
          title: args.title,
          parentId: args.parentId || null,
        }),
        requestOptions,
      );
      if (args.markdown) {
        try {
          await bodies.append(item.id, args.markdown, signal);
        } catch {
          return {
            text: JSON.stringify({
              id: item.id,
              created: true,
              contentConfirmed: false,
              instruction:
                'Note created but content was not confirmed. Read this note before retrying. Do not create another note.',
            }),
            readOnly: false,
            touchedParents: [args.parentId || null],
          };
        }
      }
      result = { id: item.id, title: item.title, created: true, contentConfirmed: true };
      break;
    }
    default: {
      const item = await check(args.itemId);
      switch (args.operation) {
        case 'read_item':
          result = item;
          break;
        case 'read_schema':
          result = await client.query(structure.effectiveSchema(item.id), requestOptions);
          break;
        case 'read_note':
        case 'append_note':
          if (item.type !== 'note') throw new Error('This operation supports note bodies only.');
          result =
            args.operation === 'read_note'
              ? await bodies.read(item.id, signal)
              : await bodies.append(item.id, args.markdown, signal);
          break;
        case 'rename_item':
          if (!args.title.trim()) throw new Error('A title is required.');
          result = await client.execute(
            items.renameItem(workspaceId, item.id, args.title),
            requestOptions,
          );
          break;
        case 'move_item':
          result = await client.execute(
            items.moveItem(workspaceId, item.id, { parentId: args.parentId || null }),
            requestOptions,
          );
          break;
        case 'set_properties': {
          const properties = z
            .record(z.string().max(160), z.unknown())
            .parse(JSON.parse(args.propertiesJson));
          result = await client.execute(
            structure.setItemProperties(item.id, properties),
            requestOptions,
          );
          break;
        }
        case 'trash_item':
          await client.execute(items.deleteItem(workspaceId, item.id), requestOptions);
          result = { id: item.id, trashed: true };
          break;
      }
    }
  }
  const text = JSON.stringify(result);
  return {
    text:
      text.length <= 16000
        ? text
        : JSON.stringify({ truncated: true, preview: text.slice(0, 15000) }),
    readOnly: READ_ONLY_OPERATIONS.has(args.operation),
    touchedParents:
      args.operation === 'create_note' || args.operation === 'move_item'
        ? [args.parentId || null]
        : [],
  };
}
