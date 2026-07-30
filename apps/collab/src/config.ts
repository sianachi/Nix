/**
 * Everything the service reads from its environment, read once and checked at startup.
 *
 * Fail-fast rather than lazily: a service that starts happily and refuses every request
 * ten minutes later, when the first person opens a document, is harder to diagnose than
 * one that never starts.
 */
export interface CollabConfig {
  readonly port: number;
  readonly host: string;

  /** The collaboration role's connection string. Never `nix_app`, never `nix_migrator`. */
  readonly databaseUrl: string;

  /** Where Core lives, for the authorization call. */
  readonly coreBaseUrl: string;

  /**
   * The secret this service presents on Core's `/internal` surface.
   *
   * It proves *which service* is calling, never *on whose behalf*: every internal request
   * also forwards the user's own token, and Core answers for that principal. Losing this
   * secret therefore yields no authority over any document its holder could not already
   * reach with a stolen user token - but it does open the internal surface, so it is
   * required rather than defaulted.
   */
  readonly internalSecret: string;

  /**
   * The issuers whose tokens are accepted, each with an optional JWKS override.
   *
   * A list because Core is multi-issuer by design - one deployment serves tenants on
   * different identity providers. This service's own check is only the cheap gate before
   * the Core round trip; Core re-validates the forwarded token against the issuer its
   * tenant registered, so an issuer listed here but not registered there still gets nothing.
   */
  readonly oidcIssuers: readonly IssuerConfig[];

  /**
   * The audiences a token may carry, any one of which is accepted.
   *
   * A list rather than a single value because one deployment legitimately mints more than one:
   * the browser's tokens carry the web client's identifier, while a machine identity's carry the
   * project's. Accepting only one of them refuses the other for no reason anybody could act on.
   */
  readonly oidcAudiences: readonly string[];

  /** Updates between snapshots. A snapshot is a materialisation, never a source of truth. */
  readonly snapshotEvery: number;

  /**
   * How often a live session's authorization is re-checked, in seconds.
   *
   * A WebSocket authorizes once at the handshake and would otherwise outlive every
   * revocation; this is the bound on how long a removed grant keeps a socket alive.
   */
  readonly reauthSeconds: number;
}

/** One accepted issuer, with an optional JWKS location when it is not at the Zitadel default. */
export interface IssuerConfig {
  readonly issuer: string;
  readonly jwksUri?: string;
}

/**
 * Roles this service must never connect as.
 *
 * `nix_migrator` holds BYPASSRLS, which would make every isolation policy decorative.
 * `nix_app` is Core's role and is granted SELECT on the content tables and nothing more -
 * connecting as it would fail every write, late and confusingly.
 */
export const FORBIDDEN_DATABASE_ROLES = ['nix_migrator', 'postgres', 'nix_app'] as const;

export function readConfig(env: NodeJS.ProcessEnv): CollabConfig {
  const databaseUrl = required(env, 'NIX_COLLAB_DATABASE_URL');
  assertRuntimeRole(databaseUrl);

  return {
    port: Number(env.NIX_COLLAB_PORT ?? 8100),
    host: env.NIX_COLLAB_HOST ?? '0.0.0.0',
    databaseUrl,
    coreBaseUrl: stripTrailingSlash(required(env, 'NIX_COLLAB_CORE_BASE_URL')),
    internalSecret: required(env, 'NIX_COLLAB_INTERNAL_SECRET'),
    oidcIssuers: readIssuers(env),
    oidcAudiences: required(env, 'NIX_COLLAB_OIDC_AUDIENCE')
      .split(',')
      .map((audience) => audience.trim())
      .filter((audience) => audience.length > 0),
    snapshotEvery: Number(env.NIX_COLLAB_SNAPSHOT_EVERY ?? 50),
    reauthSeconds: Number(env.NIX_COLLAB_REAUTH_SECONDS ?? 60),
  };
}

/**
 * Reads the accepted issuers.
 *
 * `NIX_COLLAB_OIDC_ISSUERS` is a comma-separated list of `issuer` or `issuer|jwksUri`
 * entries. The singular `NIX_COLLAB_OIDC_ISSUER` remains accepted as a one-entry list so a
 * single-tenant deployment configures one variable, not a list of one.
 */
function readIssuers(env: NodeJS.ProcessEnv): readonly IssuerConfig[] {
  const plural = env.NIX_COLLAB_OIDC_ISSUERS;
  if (plural !== undefined && plural.length > 0) {
    const issuers = plural
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry): IssuerConfig => {
        const [issuer, jwksUri] = entry.split('|', 2);
        return jwksUri === undefined || jwksUri.length === 0
          ? { issuer: stripTrailingSlash(issuer ?? '') }
          : { issuer: stripTrailingSlash(issuer ?? ''), jwksUri };
      });

    if (issuers.length === 0) {
      throw new Error(
        'NIX_COLLAB_OIDC_ISSUERS is set but names no issuers. The collaboration service ' +
          'will not start without at least one.',
      );
    }

    return issuers;
  }

  return [{ issuer: stripTrailingSlash(required(env, 'NIX_COLLAB_OIDC_ISSUER')) }];
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value.length === 0) {
    throw new Error(`${key} is required. The collaboration service will not start without it.`);
  }

  return value;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

/**
 * Refuses a connection string that authenticates as a role this service must not use.
 *
 * Checked at startup because a connection string is a deployment artefact, and deployment
 * artefacts get copy-pasted.
 */
export function assertRuntimeRole(databaseUrl: string): void {
  let user: string;
  try {
    user = decodeURIComponent(new URL(databaseUrl).username);
  } catch {
    throw new Error('NIX_COLLAB_DATABASE_URL could not be parsed as a URL.');
  }

  for (const forbidden of FORBIDDEN_DATABASE_ROLES) {
    if (user.toLowerCase() === forbidden) {
      throw new Error(
        `Refusing to start: the collaboration service is configured to connect as '${user}'. ` +
          'Use the collaboration role (nix_collab), which can write the content tables and ' +
          'cannot bypass row-level security.',
      );
    }
  }
}
