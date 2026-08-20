/**
 * Running an import plan: creating the items a plan describes, honestly.
 *
 * The same bucket discipline as the CLI's import, because the report is the product: every planned
 * node ends as a created row (which still declares a refused body or property write, with the item
 * id - a half-made item is a fact, not a failure to hide), a failed row carrying the service's own
 * words, or a not-attempted row (its parent failed, the run stopped at the write rate limit, or
 * the person cancelled). Parents are created before children, so a stop leaves a coherent partial
 * tree hanging from `rootItemId` - the one handle that undoes the whole import.
 *
 * The CLI carries a twin of this loop (`apps/cli/src/commands/import.ts`): the transports differ,
 * but the bucket names, the stop policy, and "the root is the first thing created" must stay in
 * step between the two, so a change to any of those here owes the same change there.
 */

import { isNixApiError, items, structure, type NixClient } from '@nix/api-client';

import { writeImportedBody } from './note-body-writer';
import type { PlannedNode } from './import-plan';

/**
 * The workspace the shell is scoped to - the same environment read, with the same fallback, as
 * `use-workspace-tree.ts`, which keeps its copy module-private. Real switching arrives with the
 * workspace picker, and every one of these reads collapses into it then.
 */
function readWorkspaceId(): string {
  const configured: unknown = import.meta.env.VITE_WORKSPACE_ID;
  return typeof configured === 'string' && configured.length > 0
    ? configured
    : 'a1000000-0000-4000-8000-000000000001';
}

const WORKSPACE_ID = readWorkspaceId();

export interface CreatedRow {
  readonly path: string;
  readonly itemId: string;
  readonly title: string;
  readonly bodyError?: string;
  readonly propertiesError?: string;
}

export interface PathReasonRow {
  readonly path: string;
  readonly reason: string;
}

export interface ImportRunReport {
  /** The container everything hangs under; null when even the root could not be created. */
  readonly rootItemId: string | null;
  readonly created: readonly CreatedRow[];
  readonly failed: readonly PathReasonRow[];
  readonly notAttempted: readonly PathReasonRow[];
  readonly stoppedEarly: boolean;
  /** Why the run stopped early, when it did - the rate limit, or a cancellation. */
  readonly stopReason?: string;
  /**
   * Set when the run could not begin at all - no session, or the session read itself failed. No
   * file was at fault and nothing was created, so this is its own case rather than a `failed` row
   * wearing a file's path.
   */
  readonly couldNotStart?: string;
}

export interface ImportRunRequest {
  readonly plan: PlannedNode;
  /** The item the import goes under; null for the workspace root. */
  readonly parentId: string | null;
  readonly client: NixClient;
  readonly getAccessToken: () => Promise<string | null>;
  /** Called after each attempted node, for the dialog's progress line. */
  readonly onProgress?: (done: number, total: number) => void;
  /** Aborts between items: what was made stays, the rest is reported as not attempted. */
  readonly signal?: AbortSignal;
  readonly fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  readonly collabBaseUrl?: string;
}

/**
 * Executes the plan. The report carries every failure - a refused item, a stopped run, a session
 * that could not be read - so the caller can render it without a `try` of its own; a throw
 * escaping this function is a bug, not a case.
 */
export async function runImportPlan(request: ImportRunRequest): Promise<ImportRunReport> {
  const { plan, parentId, client, getAccessToken, onProgress, signal } = request;

  const created: CreatedRow[] = [];
  const failed: PathReasonRow[] = [];
  const notAttempted: PathReasonRow[] = [];
  let stoppedEarly = false;
  let stopReason: string | undefined;
  // Captured when the root itself is created, not read back as created[0]: undo soft-deletes
  // whatever this names, and a positional read would silently name the wrong item if anything
  // were ever created before the root.
  let rootItemId: string | null = null;

  const total = countNodes(plan);
  let attempted = 0;

  // Guarded, because the session read can itself reject (a storage failure in the OIDC manager),
  // and this function's contract - it never throws, the report carries everything - has to cover
  // its first await too.
  let token: string | null;
  try {
    token = await getAccessToken();
  } catch {
    token = null;
  }
  if (token === null) {
    return {
      rootItemId: null,
      created,
      failed,
      notAttempted,
      stoppedEarly: false,
      couldNotStart: 'Your session has expired. Sign in again to import.',
    };
  }

  // A function, not an inline property read: TypeScript narrows `signal.aborted` after the first
  // check and would flag later re-checks as impossible, though an abort can arrive between any
  // two awaits.
  const cancelled = (): boolean => signal?.aborted === true;

  // Head-indexed rather than shift(): a wide folder makes a wide queue, and shift() degrades
  // sharply past a few thousand entries.
  const queue: { node: PlannedNode; parentId: string | null }[] = [{ node: plan, parentId }];
  for (let head = 0; head < queue.length; head += 1) {
    const next = queue[head];
    if (next === undefined) {
      break;
    }

    if (cancelled()) {
      stoppedEarly = true;
      stopReason = 'The import was cancelled.';
      declineSubtree(next.node, 'cancelled', notAttempted);
      drainQueue(queue, head + 1, 'cancelled', notAttempted);
      break;
    }

    let itemId: string;
    try {
      // `createItem` invalidates the workspace-tree cache key per call. Today nothing subscribes
      // to that key through the cache (the sidebar fetches directly), so an N-item import costs N
      // cheap invalidation walks and no refetches - if a tree subscriber ever appears, this loop
      // is the first place to revisit.
      const item = await client.execute(
        items.createItem(WORKSPACE_ID, {
          type: 'note',
          title: next.node.title,
          ...(next.parentId !== null ? { parentId: next.parentId } : {}),
        }),
        signal === undefined ? undefined : { signal },
      );
      itemId = item.id;
      if (head === 0) {
        rootItemId = itemId;
      }
    } catch (error) {
      // An abort mid-flight is the cancellation, not this file's failure.
      if (cancelled()) {
        stoppedEarly = true;
        stopReason = 'The import was cancelled.';
        declineSubtree(next.node, 'cancelled', notAttempted);
        drainQueue(queue, head + 1, 'cancelled', notAttempted);
        break;
      }
      if (isNixApiError(error) && error.status === 429) {
        stoppedEarly = true;
        stopReason =
          'The workspace is rate-limiting writes. What was imported so far is kept; undo it and try again in a minute.';
        declineSubtree(next.node, 'stopped at the write rate limit', notAttempted);
        drainQueue(queue, head + 1, 'stopped at the write rate limit', notAttempted);
        break;
      }
      failed.push({ path: next.node.path, reason: refusalWords(error) });
      for (const child of next.node.children) {
        declineSubtree(child, 'its parent was not imported', notAttempted);
      }
      attempted += 1;
      onProgress?.(attempted, total);
      continue;
    }

    const row: {
      path: string;
      itemId: string;
      title: string;
      bodyError?: string;
      propertiesError?: string;
    } = { path: next.node.path, itemId, title: next.node.title };
    created.push(row);

    if (next.node.doc !== null) {
      const outcome = await writeImportedBody({
        itemId,
        doc: next.node.doc,
        token,
        ...(signal === undefined ? {} : { signal }),
        ...(request.collabBaseUrl === undefined ? {} : { baseUrl: request.collabBaseUrl }),
        ...(request.fetchImpl === undefined ? {} : { fetchImpl: request.fetchImpl }),
      });
      if (!outcome.ok) {
        row.bodyError = outcome.error;
      }
    }

    if (Object.keys(next.node.properties).length > 0) {
      try {
        await client.execute(
          structure.setItemProperties(itemId, next.node.properties),
          signal === undefined ? undefined : { signal },
        );
      } catch (error) {
        row.propertiesError = refusalWords(error);
        if (cancelled()) {
          stoppedEarly = true;
          stopReason = 'The import was cancelled.';
          for (const child of next.node.children) {
            declineSubtree(child, 'cancelled', notAttempted);
          }
          drainQueue(queue, head + 1, 'cancelled', notAttempted);
          break;
        }
        if (isNixApiError(error) && error.status === 429) {
          stoppedEarly = true;
          stopReason =
            'The workspace is rate-limiting writes. What was imported so far is kept; undo it and try again in a minute.';
          for (const child of next.node.children) {
            declineSubtree(child, 'stopped at the write rate limit', notAttempted);
          }
          drainQueue(queue, head + 1, 'stopped at the write rate limit', notAttempted);
          break;
        }
      }
    }

    attempted += 1;
    onProgress?.(attempted, total);

    for (const child of next.node.children) {
      queue.push({ node: child, parentId: itemId });
    }
  }

  return {
    rootItemId,
    created,
    failed,
    notAttempted,
    stoppedEarly,
    ...(stopReason === undefined ? {} : { stopReason }),
  };
}

/** Soft-deletes the import's root container - the undo the report offers. */
export async function undoImport(
  client: NixClient,
  rootItemId: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await client.execute(
      items.deleteItem(WORKSPACE_ID, rootItemId),
      signal === undefined ? undefined : { signal },
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, error: refusalWords(error) };
  }
}

/** The service's own words where it gave them; a plain sentence otherwise. */
function refusalWords(error: unknown): string {
  if (isNixApiError(error)) {
    return error.detail ?? error.title ?? error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function declineSubtree(node: PlannedNode, reason: string, into: PathReasonRow[]): void {
  into.push({ path: node.path, reason });
  for (const child of node.children) {
    declineSubtree(child, reason, into);
  }
}

function drainQueue(
  queue: readonly { node: PlannedNode }[],
  from: number,
  reason: string,
  into: PathReasonRow[],
): void {
  for (let index = from; index < queue.length; index += 1) {
    const waiting = queue[index];
    if (waiting !== undefined) {
      declineSubtree(waiting.node, reason, into);
    }
  }
}

function countNodes(node: PlannedNode): number {
  let total = 1;
  for (const child of node.children) {
    total += countNodes(child);
  }
  return total;
}
