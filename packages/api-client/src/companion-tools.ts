import { z } from 'zod';
import type { NixClient } from './client.js';
import * as items from './resources/items.js';
import * as search from './resources/search.js';
import * as structure from './resources/structure.js';

const optionalId = z.union([z.literal(''), z.uuid()]);
export const workspaceToolSchema = z
  .object({
    operation: z.enum([
      'list_items',
      'search',
      'read_item',
      'read_note',
      'read_schema',
      'create_note',
      'append_note',
      'rename_item',
      'move_item',
      'set_properties',
      'trash_item',
      'restore_item',
    ]),
    itemId: optionalId,
    parentId: optionalId,
    title: z.string().max(240),
    markdown: z.string().max(16000),
    query: z.string().max(240),
    propertiesJson: z.string().max(8000),
  })
  .strict()
  .superRefine((args, context) => {
    const required = (field: 'itemId' | 'title' | 'markdown' | 'query') => {
      if (!args[field].trim())
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} is required for ${args.operation}.`,
        });
    };
    if (!['create_note', 'list_items', 'search'].includes(args.operation)) required('itemId');
    if (['create_note', 'rename_item'].includes(args.operation)) required('title');
    if (args.operation === 'append_note') required('markdown');
    if (args.operation === 'search') required('query');
    if (args.operation === 'set_properties') {
      try {
        z.record(z.string().max(160), z.unknown()).parse(JSON.parse(args.propertiesJson));
      } catch {
        context.addIssue({
          code: 'custom',
          path: ['propertiesJson'],
          message: 'Provide a JSON object of property values.',
        });
      }
    }
  });

export interface CompanionBodies {
  read(itemId: string, signal: AbortSignal): Promise<unknown>;
  append(itemId: string, markdown: string, signal: AbortSignal): Promise<unknown>;
}

/** A local preflight refusal with safe copy, before any mutation is attempted. */
export class WorkspaceToolRefusal extends Error {}

/** Execute only after the caller claims and approves this exact tool request. */
export async function runWorkspaceTool(
  client: NixClient,
  workspaceId: string,
  raw: string,
  bodies: CompanionBodies,
  signal: AbortSignal,
): Promise<string> {
  if (raw.length > 40000) throw new Error('Tool arguments are too large.');
  const args = workspaceToolSchema.parse(JSON.parse(raw));
  const options = { signal, forceRefresh: true };
  const check = async (id: string) => {
    if (!id) throw new Error('An item identity is required.');
    const item = await client.query(items.itemById(id), options);
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
      for await (const item of client.paginate(items.listTrash(workspaceId, 50), options)) {
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
      result = await client.execute(items.restoreItem(workspaceId, args.itemId), options);
      break;
    }
    case 'list_items': {
      const rows = [];
      let truncated = false;
      for await (const item of client.paginate(
        items.listItems(workspaceId, { parentId: args.parentId || undefined, pageSize: 50 }),
        options,
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
      const found = await client.query(search.searchItems(args.query, 50), options);
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
        options,
      );
      if (args.markdown) {
        try {
          await bodies.append(item.id, args.markdown, signal);
        } catch {
          return JSON.stringify({
            id: item.id,
            created: true,
            contentConfirmed: false,
            instruction:
              'Note created but content was not confirmed. Read this note before retrying. Do not create another note.',
          });
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
          result = await client.query(structure.effectiveSchema(item.id), options);
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
            options,
          );
          break;
        case 'move_item':
          result = await client.execute(
            items.moveItem(workspaceId, item.id, { parentId: args.parentId || null }),
            options,
          );
          break;
        case 'set_properties': {
          const properties = z
            .record(z.string().max(160), z.unknown())
            .parse(JSON.parse(args.propertiesJson));
          result = await client.execute(structure.setItemProperties(item.id, properties), options);
          break;
        }
        case 'trash_item':
          await client.execute(items.deleteItem(workspaceId, item.id), options);
          result = { id: item.id, trashed: true };
          break;
      }
    }
  }
  const text = JSON.stringify(result);
  return text.length <= 16000
    ? text
    : JSON.stringify({ truncated: true, preview: text.slice(0, 15000) });
}
