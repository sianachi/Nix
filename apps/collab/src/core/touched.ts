import type { DocumentSession } from '../documents/session.ts';

/**
 * Tells Core an item's body changed, once per flush.
 *
 * Core owns the envelope and this service owns the content, so without this the "edited
 * five minutes ago" stamp goes stale the moment editing moves to the socket. The call
 * forwards the last writer's own token - Core stamps the change as that principal, and
 * this service still holds no authority of its own - plus the internal secret that proves
 * which service is calling.
 *
 * **Best-effort by contract.** The flush already committed; the log is the source of
 * truth; a missed notification costs a stale stamp until the next flush lands. So
 * failures are swallowed after a bounded wait rather than turning a durable write into a
 * user-visible error.
 */
export function createTouchedNotifier(options: {
  coreBaseUrl: string;
  internalSecret: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}): (session: DocumentSession) => void {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;

  return (session: DocumentSession): void => {
    const writer = session.lastWriter;
    if (writer === null) {
      return;
    }

    void doFetch(`${options.coreBaseUrl}/internal/items/${session.itemId}/touched`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${writer.token}`,
        'x-nix-internal-secret': options.internalSecret,
      },
      signal: AbortSignal.timeout(timeoutMs),
    }).catch(() => undefined);
  };
}
