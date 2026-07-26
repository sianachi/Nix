/**
 * The items resource: the only place item URLs appear.
 *
 * Every method returns a descriptor rather than performing a request, so the client decides how it
 * is executed — deduplicated, cached, cancelled — and a caller writes `client.query(items.byId(id))`
 * without ever seeing a path. That is what keeps URL construction out of components.
 *
 * Paths are written against the committed contract at `backend/openapi/nix-api.json`. Every
 * operation below currently answers 501 with `api.not_implemented`: the shapes are real and stable,
 * the behaviour arrives with the goal that implements them. Build against MSW until then — a 501 is
 * deliberately impossible to mistake for a working endpoint.
 */

import {
  defineCommand,
  definePagedQuery,
  defineQuery,
  type CommandEndpoint,
  type PagedQueryEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import { itemSchema, noContentSchema, type Item } from '../schemas/index.js';

/** Cache key prefix for everything under one workspace's tree. */
const workspaceTreeKey = (workspaceId: string): readonly string[] => [
  'workspaces',
  workspaceId,
  'items',
];

/** Cache key for one item. */
const itemKey = (itemId: string): readonly string[] => ['items', itemId];

export interface ListItemsOptions {
  /** The folder to list, or omitted for the workspace roots. */
  readonly parentId?: string | undefined;
  /** Whether soft-deleted items are included. Off by default, as the contract defaults it. */
  readonly includeDeleted?: boolean | undefined;
  /** Items per page; the server decides what it actually returns. */
  readonly pageSize?: number | undefined;
}

/** The children of a folder, or the workspace roots, in sibling order. */
export const listItems = (
  workspaceId: string,
  options: ListItemsOptions = {},
): PagedQueryEndpoint<Item> =>
  definePagedQuery<Item>({
    operation: 'items.list',
    path: `/api/v1/workspaces/${workspaceId}/items`,
    itemSchema,
    query: {
      parentId: options.parentId,
      includeDeleted: options.includeDeleted,
    },
    pageSize: options.pageSize,
  });

/** One item. */
export const itemById = (itemId: string): QueryEndpoint<Item> =>
  defineQuery<Item>({
    operation: 'items.get',
    path: `/api/v1/items/${itemId}`,
    schema: itemSchema,
    cacheKey: itemKey(itemId),
  });

export interface CreateItemInput {
  readonly type: string;
  readonly title: string;
  readonly parentId?: string | null | undefined;
}

/** Creates an item under a parent, or at the workspace root when the parent is null. */
export const createItem = (workspaceId: string, input: CreateItemInput): CommandEndpoint<Item> =>
  defineCommand<Item>({
    operation: 'items.create',
    method: 'POST',
    path: `/api/v1/workspaces/${workspaceId}/items`,
    schema: itemSchema,
    body: {
      type: input.type,
      title: input.title,
      parentId: input.parentId ?? null,
    },
    invalidates: [workspaceTreeKey(workspaceId)],
  });

/** Renames an item. Moving and deleting are separate operations, as the contract has them. */
export const renameItem = (
  workspaceId: string,
  itemId: string,
  title: string,
): CommandEndpoint<Item> =>
  defineCommand<Item>({
    operation: 'items.rename',
    method: 'PATCH',
    path: `/api/v1/items/${itemId}`,
    schema: itemSchema,
    body: { title },
    invalidates: [itemKey(itemId), workspaceTreeKey(workspaceId)],
  });

export interface MoveItemInput {
  /** The new parent, or null for the workspace root. */
  readonly parentId: string | null;
  /** The sibling to place it after, or null to place it first. */
  readonly afterId?: string | null | undefined;
}

/**
 * Moves an item to a new parent.
 *
 * Fails with `items.move_would_create_cycle` when the destination is the item itself or one of its
 * descendants — which is what dragging a folder onto its own child does, so it is an ordinary
 * outcome a view should render rather than an error to report.
 */
export const moveItem = (
  workspaceId: string,
  itemId: string,
  input: MoveItemInput,
): CommandEndpoint<Item> =>
  defineCommand<Item>({
    operation: 'items.move',
    method: 'POST',
    path: `/api/v1/items/${itemId}/move`,
    schema: itemSchema,
    body: { parentId: input.parentId, afterId: input.afterId ?? null },
    invalidates: [itemKey(itemId), workspaceTreeKey(workspaceId)],
  });

/** Soft-deletes an item. The subtree stays intact and restoring is the same flag flipped back. */
export const deleteItem = (workspaceId: string, itemId: string): CommandEndpoint<undefined> =>
  defineCommand<undefined>({
    operation: 'items.delete',
    method: 'DELETE',
    path: `/api/v1/items/${itemId}`,
    schema: noContentSchema,
    invalidates: [itemKey(itemId), workspaceTreeKey(workspaceId)],
  });

/** Restores a soft-deleted item. */
export const restoreItem = (workspaceId: string, itemId: string): CommandEndpoint<Item> =>
  defineCommand<Item>({
    operation: 'items.restore',
    method: 'POST',
    path: `/api/v1/items/${itemId}/restore`,
    schema: itemSchema,
    invalidates: [itemKey(itemId), workspaceTreeKey(workspaceId)],
  });
