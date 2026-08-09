import type { SchemaSnapshot, ViewsSnapshot } from '@nix/export';

/**
 * Reads from Core, with the caller's own token.
 *
 * **This service holds no service credential and asks no privileged question.** It forwards the
 * bearer it was handed and takes Core's answer, exactly as `auth/authorize.ts` does for the
 * permission check - so an export sees precisely what its caller would see through the browser, and
 * a permission change takes effect here the moment it takes effect there. A listing already omits
 * what the caller cannot read rather than redacting it, so the filtering an export needs is
 * something Core has already done by the time these functions return.
 *
 * The cost is a round trip per item per fact. That is the thing to replace when a 10k-item export
 * arrives (MVP-6.5's E9) - with a bulk read in Core, behind the same authorization port, not with a
 * privileged shortcut from here.
 */

export interface CoreItem {
  readonly id: string;
  readonly workspaceId: string;
  readonly parentId: string | null;
  readonly type: string;
  readonly title: string;
  readonly hasChildren: boolean;
  readonly seq: string;
  readonly lifecycleState: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChildPage {
  readonly items: readonly CoreItem[];
  readonly nextCursor: string | null;
}

export interface CoreClient {
  getItem(token: string, itemId: string): Promise<CoreItem | null>;
  listChildren(
    token: string,
    workspaceId: string,
    parentId: string,
    cursor: string | null,
  ): Promise<ChildPage | null>;
  getSchema(token: string, itemId: string): Promise<SchemaSnapshot | null>;
  getViews(token: string, itemId: string): Promise<ViewsSnapshot | null>;
}

export interface CoreClientOptions {
  readonly coreBaseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export function createCoreClient(options: CoreClientOptions): CoreClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;

  /** The parsed body, or null for anything that was not a successful JSON answer. */
  async function read(token: string, path: string): Promise<unknown> {
    // Bounded, for the same reason the authorizer bounds its own: a Core that has stopped answering
    // must not become this service holding connections open until it runs out of them.
    try {
      const response = await doFetch(`${options.coreBaseUrl}${path}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        return null;
      }

      return await response.json();
    } catch {
      return null;
    }
  }

  return {
    async getItem(token, itemId) {
      return toItem(await read(token, `/api/v1/items/${itemId}`));
    },

    async listChildren(token, workspaceId, parentId, cursor) {
      const query = new URLSearchParams({ parentId, limit: '200' });
      if (cursor !== null) {
        query.set('cursor', cursor);
      }

      const page = await read(token, `/api/v1/workspaces/${workspaceId}/items?${query.toString()}`);

      if (!isRecord(page) || !Array.isArray(page.items)) {
        return null;
      }

      const items: CoreItem[] = [];
      for (const raw of page.items) {
        const item = toItem(raw);
        // A row this build cannot parse is dropped rather than guessed at. It shows up as a
        // difference between what the manifest lists and what the caller expected, which is
        // visible, where a half-populated item would not be.
        if (item !== null) {
          items.push(item);
        }
      }

      const next = page.nextCursor;
      return { items, nextCursor: typeof next === 'string' ? next : null };
    },

    async getSchema(token, itemId) {
      const body = await read(token, `/api/v1/items/${itemId}/schema`);
      if (!isRecord(body)) {
        return null;
      }

      const properties = toProperties(body.properties);
      const declared = toProperties(body.declared);

      return {
        properties,
        declared,
        inherit: body.inherit === true,
      };
    },

    async getViews(token, itemId) {
      const body = await read(token, `/api/v1/items/${itemId}/views`);
      if (!isRecord(body) || !Array.isArray(body.views)) {
        return null;
      }

      const views = body.views.filter(isRecord).map((view) => ({
        id: text(view.id),
        name: text(view.name),
        kind: text(view.kind),
        columns: Array.isArray(view.columns) ? view.columns.map(text) : [],
        groupBy: nullableText(view.groupBy),
        groupOrder: Array.isArray(view.groupOrder) ? view.groupOrder.map(text) : [],
        dateProperty: nullableText(view.dateProperty),
        sortBy: nullableText(view.sortBy),
        sortDescending: view.sortDescending === true,
        mode: nullableText(view.mode),
        coverProperty: nullableText(view.coverProperty),
        endDateProperty: nullableText(view.endDateProperty),
        cardSize: nullableText(view.cardSize),
      }));

      return { views, default: text(body.default) };
    },
  };
}

function toItem(raw: unknown): CoreItem | null {
  if (!isRecord(raw)) {
    return null;
  }

  const id = raw.id;
  const workspaceId = raw.workspaceId;
  if (typeof id !== 'string' || typeof workspaceId !== 'string') {
    return null;
  }

  return {
    id,
    workspaceId,
    parentId: nullableText(raw.parentId),
    type: text(raw.type),
    title: text(raw.title),
    hasChildren: raw.hasChildren === true,
    // `seq` is an int64 and arrives as either a number or a string. Kept as a string throughout,
    // because sibling order is data and a value past 2^53 that silently rounds would reorder
    // somebody's board.
    seq: text(raw.seq),
    lifecycleState: text(raw.lifecycleState),
    properties: isRecord(raw.properties) ? raw.properties : {},
    createdAt: text(raw.createdAt),
    updatedAt: text(raw.updatedAt),
  };
}

function toProperties(raw: unknown): SchemaSnapshot['properties'] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.filter(isRecord).map((property) => ({
    key: text(property.key),
    label: text(property.label),
    type: text(property.type),
    options: Array.isArray(property.options) ? property.options.map(text) : [],
    required: property.required === true,
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
