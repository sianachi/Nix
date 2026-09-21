/**
 * A document's history, read from the collaboration service: revisions coalesced from the update
 * log, the reconstructed state at any `seq`, restoring the head to an earlier state, and the named
 * versions that pin a `seq` against retention.
 *
 * **The history API is document-generic and lives in the same service `body.ts` already speaks**,
 * so this follows the same shape: plain fetches against `collabUrl`, a bearer token, and a problem
 * document turned into a `NixApiError` so the CLI's exit-code mapping (`toFailure` in `output.ts`)
 * treats a 404 as not-found and a 401/403 as refused without history inventing its own scheme.
 */

import { NixApiError } from '@nix/api-client';
import type { FetchImpl } from './session.ts';

/** How long one collab request may take before it is abandoned; matches `body.ts`. */
const HISTORY_TIMEOUT_MS = 30_000;

/** The seams every history call takes: where to send the request and how to authenticate it. */
interface HistoryRequest {
  readonly collabUrl: string;
  readonly itemId: string;
  readonly token: string;
  readonly fetchImpl?: FetchImpl;
}

export interface RevisionSummary {
  readonly seq: number;
  readonly fromSeq: number;
  readonly actorId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly updateCount: number;
  readonly name: string | null;
}

export interface RevisionsPage {
  readonly revisions: readonly RevisionSummary[];
  readonly hasMore: boolean;
  readonly headSeq: number;
}

/** Collab enforces this cap on `limit`; asking above it is refused, so the CLI checks first. */
export const MAX_HISTORY_LIMIT = 100;

/**
 * Lists revisions, newest first, paging backwards with `before`.
 *
 * @throws {NixApiError} When the item's history is not visible, or the request cannot complete.
 */
export async function listRevisions(
  input: HistoryRequest & { readonly limit: number; readonly before?: number },
): Promise<RevisionsPage> {
  const params = new URLSearchParams({ limit: String(input.limit) });
  if (input.before !== undefined) {
    params.set('before', String(input.before));
  }
  const response = await request(input, `/documents/${input.itemId}/history?${params.toString()}`);
  return (await response.json()) as RevisionsPage;
}

export interface RevisionState {
  readonly seq: number;
  /** The document as ProseMirror JSON, as it stood at `seq`. */
  readonly document: unknown;
  readonly plaintext: string;
  readonly headSeq: number;
}

/**
 * Reconstructs the document as it stood at `seq`.
 *
 * @throws {NixApiError} 404 `history_state_unavailable` when `seq` is beyond the head or below the
 *   oldest retained base; otherwise the usual visibility and connectivity failures.
 */
export async function getRevisionState(
  input: HistoryRequest & { readonly seq: number },
): Promise<RevisionState> {
  const response = await request(input, `/documents/${input.itemId}/history/${String(input.seq)}`);
  return (await response.json()) as RevisionState;
}

export interface RestoreResult {
  readonly headSeq: number;
}

/**
 * Replaces the document's current state with the state at `seq`, as one new revision attributed to
 * the caller. History itself is never deleted - the restore is additive.
 *
 * @throws {NixApiError} When the caller cannot write the document, or `seq` is not reachable.
 */
export async function restoreRevision(
  input: HistoryRequest & { readonly seq: number },
): Promise<RestoreResult> {
  const response = await request(
    input,
    `/documents/${input.itemId}/history/${String(input.seq)}/restore`,
    { method: 'POST', body: '{}' },
  );
  return (await response.json()) as RestoreResult;
}

export interface NamedVersion {
  readonly seq: number;
  readonly name: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

/** @throws {NixApiError} When the item's history is not visible. */
export async function listNamedVersions(
  input: HistoryRequest,
): Promise<{ readonly versions: readonly NamedVersion[] }> {
  const response = await request(input, `/documents/${input.itemId}/versions`);
  return (await response.json()) as { readonly versions: readonly NamedVersion[] };
}

/**
 * Names a revision, pinning a snapshot at `seq` so retention can never remove it.
 *
 * @throws {NixApiError} When the caller cannot write the document, or `seq` is not reachable.
 */
export async function nameVersion(
  input: HistoryRequest & { readonly seq: number; readonly name: string },
): Promise<NamedVersion> {
  const response = await request(input, `/documents/${input.itemId}/versions`, {
    method: 'POST',
    body: JSON.stringify({ seq: input.seq, name: input.name }),
  });
  return (await response.json()) as NamedVersion;
}

async function request(
  input: HistoryRequest,
  path: string,
  init: { readonly method?: string; readonly body?: string } = {},
): Promise<Response> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(`${input.collabUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${input.token}`,
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: init.body } : {}),
    signal: AbortSignal.timeout(HISTORY_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw await historyError(response);
  }
  return response;
}

/**
 * Turns a non-2xx collab response into a `NixApiError`, so `toFailure` maps it the same way a Core
 * problem document would: a 404 to "not found", a 401/403 to "refused", anything else general.
 */
async function historyError(response: Response): Promise<NixApiError> {
  try {
    const body: unknown = await response.json();
    if (
      typeof body === 'object' &&
      body !== null &&
      'code' in body &&
      typeof body.code === 'string'
    ) {
      const problem = body as { code: string; title?: string; detail?: string };
      return NixApiError.fromProblemDetails(response.status, {
        code: problem.code,
        title: problem.title,
        detail: problem.detail,
      });
    }
  } catch {
    // Falls through to the status-only failure below.
  }
  return NixApiError.fromStatus(
    response.status,
    response.status === 404
      ? 'That history is not available to you.'
      : `The history request was refused (${String(response.status)}).`,
  );
}
