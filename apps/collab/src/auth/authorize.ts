/**
 * What Core says about an item the caller asked for.
 *
 * `tenantId` and `principalId` come from `/api/v1/me`, and `workspaceId` from the item.
 * All three are Core's answers rather than this service's guesses, which is the point:
 * there is one authorization code path in the system and it is not this file.
 */
export interface ItemAuthorization {
  readonly tenantId: string;
  readonly principalId: string;
  readonly workspaceId: string;
}

export interface Authorizer {
  /**
   * Whether the bearer of this token may reach this item, and in which tenant.
   *
   * Null means refused - and refused is all a caller may learn. Core reports an item the
   * caller cannot see as not found, so "does not exist" and "not yours" are the same answer
   * there and must stay the same answer here.
   */
  authorize(token: string, itemId: string): Promise<ItemAuthorization | null>;
}

/**
 * Authorization by forwarding the caller's own token to Core.
 *
 * **No service credential, no `/internal` endpoint, no permission logic here.** This service
 * asks Core the same question the browser would, with the same token, and takes the answer:
 * `200` allows, anything else refuses. The consequences are all good ones - a permission
 * change takes effect here the moment it takes effect there; there is no second
 * implementation of the rules to drift; and a compromise of this process yields no
 * authority its callers did not already have, because it holds no credential of its own.
 *
 * The cost is one round trip per request that opens or writes a document. That is
 * acceptable at MVP-1's traffic and is the thing to revisit - with a cache keyed on the
 * token and bounded by the token's own lifetime - when the WebSocket arrives and a session
 * stops being one request.
 */
export function createAuthorizer(options: {
  coreBaseUrl: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}): Authorizer {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;

  async function get(token: string, path: string): Promise<Response | null> {
    // Bounded, because a Core that has stopped answering must not turn into this service
    // holding connections open until it runs out of them.
    const abort = AbortSignal.timeout(timeoutMs);

    try {
      return await doFetch(`${options.coreBaseUrl}${path}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: abort,
      });
    } catch {
      return null;
    }
  }

  return {
    async authorize(token: string, itemId: string): Promise<ItemAuthorization | null> {
      const [itemResponse, meResponse] = await Promise.all([
        get(token, `/api/v1/items/${itemId}`),
        get(token, '/api/v1/me'),
      ]);

      if (itemResponse === null || !itemResponse.ok || !meResponse?.ok) {
        return null;
      }

      const item = (await itemResponse.json()) as { workspaceId?: unknown };
      const me = (await meResponse.json()) as { id?: unknown; tenantId?: unknown };

      if (
        typeof item.workspaceId !== 'string' ||
        typeof me.id !== 'string' ||
        typeof me.tenantId !== 'string'
      ) {
        return null;
      }

      return { tenantId: me.tenantId, principalId: me.id, workspaceId: item.workspaceId };
    },
  };
}
