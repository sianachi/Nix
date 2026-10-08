import { items, type NixClient, type pets } from '@nix/api-client';
import { localTimeZone } from '../lib/date-format';

/** The most containers a conversation's first message describes; Core and the worker refuse more. */
export const WORKSPACE_MAP_LIMIT = 40;

/** How many top-level containers have their own children read for the map's second level. Each
 * is one request, so this bounds the work a first message costs on a workspace with many roots. */
const EXPANDED_ROOTS = 8;

/** How long the map may take before the message goes without it. A map is a convenience; a reply
 * waiting on it is not. */
const MAP_TIMEOUT_MS = 3000;

/** The owner's day and zone as the browser knows them, sent with every message so the pet can
 * resolve "tomorrow" or "this Friday" in the owner's own calendar rather than the server's. */
export function ownerTurnContext(now: Date = new Date()): { today: string; timeZone: string } {
  const timeZone = localTimeZone();
  let today: string;
  try {
    // en-CA formats a calendar day as yyyy-MM-dd.
    today = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    today = now.toISOString().slice(0, 10);
  }
  return { today, timeZone };
}

/** View kinds for a container only when this client already holds them: the map never spends a
 * request per container just to name its views. */
function cachedViewKinds(client: NixClient, itemId: string): readonly string[] | undefined {
  for (const key of [
    ['items', itemId, 'views'],
    ['items', itemId, 'view-configurations'],
  ]) {
    const entry = client.cache.peek<{ views?: readonly { kind?: unknown }[] }>(key);
    const views = entry?.data.views;
    if (views !== undefined)
      return views.flatMap((view) => (typeof view.kind === 'string' ? [view.kind] : []));
  }
  return undefined;
}

async function firstPage(
  client: NixClient,
  workspaceId: string,
  parentId: string | undefined,
  signal: AbortSignal,
) {
  const children = [];
  for await (const item of client.paginate(
    items.listItems(workspaceId, { parentId, pageSize: 50 }),
    {
      signal,
      maxPages: 1,
    },
  ))
    children.push(item);
  return children;
}

/**
 * The workspace's main containers for a conversation's first message (plan B.2): every
 * top-level item, then the containers one level below the first few, up to
 * `WORKSPACE_MAP_LIMIT`. Each entry carries the container's id, title and body type, and its view
 * kinds when they are already cached here. Everything comes from reads the owner's own client is
 * allowed to make, so the map can only name what the owner can already see. Resolves to undefined
 * when the reads fail or take longer than `MAP_TIMEOUT_MS`: the message is then sent without it.
 */
export async function buildWorkspaceMap(
  client: NixClient,
  workspaceId: string,
  signal: AbortSignal,
): Promise<pets.PetWorkspaceMapEntry[] | undefined> {
  const timeout = AbortSignal.timeout(MAP_TIMEOUT_MS);
  const bounded = AbortSignal.any([signal, timeout]);
  try {
    const roots = await firstPage(client, workspaceId, undefined, bounded);
    const seconds = await Promise.all(
      roots
        .filter((root) => root.hasChildren)
        .slice(0, EXPANDED_ROOTS)
        .map(async (root) =>
          (await firstPage(client, workspaceId, root.id, bounded)).filter(
            (child) => child.hasChildren,
          ),
        ),
    );
    return [...roots, ...seconds.flat()].slice(0, WORKSPACE_MAP_LIMIT).map((item) => {
      const viewKinds = cachedViewKinds(client, item.id);
      return {
        id: item.id,
        title: item.title.slice(0, 240),
        type: item.type.slice(0, 64),
        ...(viewKinds === undefined ? {} : { viewKinds: viewKinds.slice(0, 12) }),
      };
    });
  } catch {
    return undefined;
  }
}
