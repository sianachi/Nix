import type { Authorizer, ItemAuthorization } from '../auth/authorize.ts';
import type { TokenValidator } from '../auth/token.ts';

/**
 * Everything a session knows about who it serves, established once and re-checked on a
 * timer rather than per message.
 */
export interface SessionAuthorization extends ItemAuthorization {
  /** The token's subject, for logs that must name who was refused. */
  readonly subject: string;

  /**
   * When the credential behind this authorization stops being valid, in epoch
   * milliseconds, or null when the token does not say.
   */
  readonly tokenExpiresAt: number | null;
}

/**
 * How a session establishment can end.
 *
 * The two refusals stay distinguishable because the client's correct reactions differ: an
 * unauthenticated caller should acquire a fresh token and try again, while a refused one
 * should stop asking. What is *not* distinguishable is why authorization was refused -
 * "does not exist" and "not yours" remain the same answer.
 */
export type SessionResult =
  | { readonly ok: true; readonly value: SessionAuthorization }
  | { readonly ok: false; readonly reason: 'unauthenticated' | 'refused' };

export interface SessionAuthenticator {
  /** Authenticates the token and authorizes it against the item, through the cache. */
  authenticate(token: string, itemId: string): Promise<SessionResult>;

  /** Drops expired entries. Called on a timer by the server, like the rate window. */
  sweep(): void;

  /** How many answers are cached, for the metrics gauge. */
  readonly size: number;
}

/**
 * The transport-neutral half of the handshake: token in, authorization out.
 *
 * Both the HTTP endpoints and the WebSocket handshake come through here, so there is one
 * cache and one behaviour. The cache is what makes a session affordable - without it every
 * re-check and every HTTP request costs a Core round trip - and its bound is the token's
 * own lifetime: **a cached "yes" must never outlive the credential it answered for.** A
 * revocation therefore reaches a live session within the re-check interval plus the cache
 * age, both of which are configuration, and neither of which is "when the token expires".
 */
export function createSessionAuthenticator(options: {
  tokens: TokenValidator;
  authorizer: Authorizer;
  /** How long a cached answer may be believed. Defaults to thirty seconds. */
  cacheTtlMs?: number;
  now?: () => number;
}): SessionAuthenticator {
  const cacheTtlMs = options.cacheTtlMs ?? 30_000;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { value: SessionAuthorization; expiresAt: number }>();

  return {
    async authenticate(token: string, itemId: string): Promise<SessionResult> {
      const key = `${itemId}\n${token}`;
      const cached = cache.get(key);
      if (cached !== undefined && cached.expiresAt > now()) {
        return { ok: true, value: cached.value };
      }
      cache.delete(key);

      const validated = await options.tokens.validate(token);
      if (validated === null) {
        // Refused before Core is asked anything: a token that does not validate must not
        // cost a round trip, and must not learn whether the item exists.
        return { ok: false, reason: 'unauthenticated' };
      }

      const authorization = await options.authorizer.authorize(token, itemId);
      if (authorization === null) {
        return { ok: false, reason: 'refused' };
      }

      const value: SessionAuthorization = {
        ...authorization,
        subject: validated.subject,
        tokenExpiresAt: validated.expiresAt,
      };

      const expiresAt =
        validated.expiresAt === null
          ? now() + cacheTtlMs
          : Math.min(now() + cacheTtlMs, validated.expiresAt);
      if (expiresAt > now()) {
        cache.set(key, { value, expiresAt });
      }

      return { ok: true, value };
    },

    sweep(): void {
      const at = now();
      for (const [key, entry] of cache) {
        if (entry.expiresAt <= at) {
          cache.delete(key);
        }
      }
    },

    get size(): number {
      return cache.size;
    },
  };
}
