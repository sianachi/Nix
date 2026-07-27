import { createRemoteJWKSet, jwtVerify } from 'jose';

/**
 * What a validated token tells this service, and no more.
 *
 * The subject and nothing else. **No roles, no permissions, no tenant.** A token is a bearer
 * artefact minted minutes ago by a system we do not control; roles inside one cannot be
 * revoked before it expires. Who the caller may act as, and what they may reach, are
 * answered by Core against the database - see `authorizeItem`.
 */
export interface ValidatedToken {
  readonly subject: string;
}

export interface TokenValidator {
  validate(token: string): Promise<ValidatedToken | null>;
}

/**
 * Validates bearer tokens against one issuer's published keys.
 *
 * Single-issuer, unlike Core, which resolves the issuer per tenant from the database. That
 * is a deliberate narrowing rather than an oversight: this service never sees a request
 * that Core has not already authorized, so it does not need to decide which tenant a token
 * belongs to - it needs only to be sure the token is genuine before spending a round trip
 * asking Core about it. Multi-issuer arrives here when it arrives for real deployments.
 *
 * `createRemoteJWKSet` caches the key set and refetches on an unknown key id, rate-limited
 * internally, which is the behaviour Core had to be taught by hand.
 */
export function createTokenValidator(options: {
  issuer: string;
  /** Any one of these is accepted; see `CollabConfig.oidcAudiences` for why it is a list. */
  audiences: readonly string[];
  jwksUri?: string;
}): TokenValidator {
  const jwks = createRemoteJWKSet(
    new URL(options.jwksUri ?? `${options.issuer}/oauth/v2/keys`),
    // A key set that never refreshes is a key set that stops working the day the issuer
    // rotates. Ten minutes is short enough that a rotation is invisible and long enough
    // that ordinary traffic does not hammer the issuer.
    { cacheMaxAge: 600_000 },
  );

  return {
    async validate(token: string): Promise<ValidatedToken | null> {
      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer: options.issuer,
          audience: [...options.audiences],
          // Signing algorithms are named rather than inferred. Left open, a token could
          // choose its own - which is how "alg: none" became a class of vulnerability.
          algorithms: ['RS256', 'ES256'],
        });

        return typeof payload.sub === 'string' && payload.sub.length > 0
          ? { subject: payload.sub }
          : null;
      } catch {
        // Deliberately opaque to the caller. Which of expiry, signature, audience or issuer
        // failed is useful to an attacker probing the endpoint and useless to a client,
        // which can do exactly one thing about any of them: get a new token.
        return null;
      }
    },
  };
}
