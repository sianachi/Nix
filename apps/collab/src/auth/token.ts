import { createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose';

import type { IssuerConfig } from '../config.ts';

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

  /**
   * When the token stops being valid, in epoch milliseconds, or null when it does not say.
   *
   * Carried so a session can bound its authorization cache by the token's own lifetime -
   * a cached "yes" must never outlive the credential it answered for.
   */
  readonly expiresAt: number | null;
}

export interface TokenValidator {
  validate(token: string): Promise<ValidatedToken | null>;
}

/**
 * Validates bearer tokens against the published keys of the issuers this deployment accepts.
 *
 * Multi-issuer, like Core, but from configuration rather than the database: this service's
 * role is granted the content tables and nothing else, so it cannot read the tenant's
 * identity-provider registrations. The check here is only the cheap gate before the Core
 * round trip - Core re-validates the forwarded token against the issuer its tenant
 * registered, so an issuer configured here but not registered there still gets nothing.
 *
 * The issuer is picked by decoding the unverified `iss` claim, exactly as Core does: the
 * claim routes the lookup, and only the verification that follows is believed.
 *
 * `createRemoteJWKSet` caches each key set and refetches on an unknown key id, rate-limited
 * internally, which is the behaviour Core had to be taught by hand.
 */
export function createTokenValidator(options: {
  issuers: readonly IssuerConfig[];
  /** Any one of these is accepted; see `CollabConfig.oidcAudiences` for why it is a list. */
  audiences: readonly string[];
}): TokenValidator {
  const keySets = new Map(
    options.issuers.map((entry) => [
      entry.issuer,
      createRemoteJWKSet(
        new URL(entry.jwksUri ?? `${entry.issuer}/oauth/v2/keys`),
        // A key set that never refreshes is a key set that stops working the day the issuer
        // rotates. Ten minutes is short enough that a rotation is invisible and long enough
        // that ordinary traffic does not hammer the issuer.
        { cacheMaxAge: 600_000 },
      ),
    ]),
  );

  return {
    async validate(token: string): Promise<ValidatedToken | null> {
      try {
        const issuer = decodeJwt(token).iss;
        if (issuer === undefined) {
          return null;
        }

        const jwks = keySets.get(issuer);
        if (jwks === undefined) {
          return null;
        }

        const { payload } = await jwtVerify(token, jwks, {
          issuer,
          audience: [...options.audiences],
          // Signing algorithms are named rather than inferred. Left open, a token could
          // choose its own - which is how "alg: none" became a class of vulnerability.
          algorithms: ['RS256', 'ES256'],
        });

        return typeof payload.sub === 'string' && payload.sub.length > 0
          ? { subject: payload.sub, expiresAt: payload.exp === undefined ? null : payload.exp * 1000 }
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
