/**
 * The ceilings an update has to fit inside, and why each one exists.
 *
 * These are the dev document's section 17 rules, and they belong here now rather than
 * arriving with the WebSocket. A client can post anything over HTTP exactly as it can send
 * anything over a socket; a limit that only exists on the socket path is not a limit.
 *
 * Every one of them is checked **after** the merge, not before. A payload that is small on
 * its own can still take the document past a ceiling, and the document is what has to stay
 * openable.
 */
export const LIMITS = {
  /**
   * One update's payload. Matches the CHECK constraint on `content_update.update_bytes`,
   * so a payload that passes here cannot fail at the database and produce a 500 where a
   * 413 was meant.
   */
  updateBytes: 1024 * 1024,

  /** A snapshot's state vector. Matches the CHECK on `content_snapshot.yjs_state`. */
  snapshotBytes: 16 * 1024 * 1024,

  /**
   * Nodes in the merged document. The cost that matters is the one the browser pays
   * rendering the tree, and a hundred thousand empty paragraphs is a worse document than
   * a megabyte of prose.
   */
  documentNodes: 100_000,

  /** Serialised size of the merged document. */
  documentBytes: 8 * 1024 * 1024,

  /** Updates one principal may post to one document per window, and the window. */
  updatesPerWindow: 600,
  windowMs: 60_000,
} as const;

export type RejectionCode =
  | 'update_too_large'
  | 'update_unreadable'
  | 'schema_version_mismatch'
  | 'document_above_schema_pin'
  | 'document_does_not_parse'
  | 'document_too_many_nodes'
  | 'document_too_large'
  | 'rate_limited'
  | 'read_only';

export interface Rejection {
  readonly code: RejectionCode;
  readonly detail: string;
  readonly status: number;
}

export function rejection(code: RejectionCode, detail: string): Rejection {
  return { code, detail, status: statusFor(code) };
}

function statusFor(code: RejectionCode): number {
  switch (code) {
    case 'update_too_large':
    case 'document_too_many_nodes':
    case 'document_too_large':
      return 413;
    case 'rate_limited':
      return 429;
    case 'schema_version_mismatch':
    case 'document_above_schema_pin':
      // Conflict rather than unprocessable: the update is well-formed and the document is
      // fine. What is wrong is the order of two deployments, and retrying after the pin
      // migration has run is the correct response - which is what 409 means and 422 does not.
      return 409;
    case 'read_only':
      // Forbidden rather than not-found: a reader already knows the item exists, so the
      // honest answer is "you may see this and not change it", which they can act on.
      return 403;
    case 'update_unreadable':
    case 'document_does_not_parse':
      return 422;
  }
}

/**
 * Per-principal, per-document backpressure.
 *
 * A fixed window rather than a token bucket, because the thing being resisted is a runaway
 * client posting in a loop, not a burst that needs smoothing - a person typing produces
 * far fewer updates than this in a minute, and a client that exceeds it is broken rather
 * than busy.
 *
 * In memory, and honest about it: with more than one replica the effective limit is the
 * window times the number of replicas. That is fine for what this defends against and
 * would not be fine for billing, which is why it is not used for billing.
 */
export class RateWindow {
  readonly #counts = new Map<string, { count: number; startedAt: number }>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Records an attempt, and says whether it is over the limit. */
  exceeded(principalId: string, docId: string): boolean {
    const key = `${principalId}:${docId}`;
    const now = this.#now();
    const existing = this.#counts.get(key);

    if (existing === undefined || now - existing.startedAt >= LIMITS.windowMs) {
      this.#counts.set(key, { count: 1, startedAt: now });
      return false;
    }

    existing.count += 1;
    return existing.count > LIMITS.updatesPerWindow;
  }

  /**
   * Drops windows that have expired.
   *
   * Called on a timer by the server. Without it the map grows by one entry per principal
   * per document for the process's lifetime, which is a slow leak rather than a fast one
   * and therefore the kind that reaches production.
   */
  sweep(): void {
    const now = this.#now();
    for (const [key, window] of this.#counts) {
      if (now - window.startedAt >= LIMITS.windowMs) {
        this.#counts.delete(key);
      }
    }
  }

  get size(): number {
    return this.#counts.size;
  }
}
