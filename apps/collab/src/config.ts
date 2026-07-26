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

  /** The issuer whose tokens are accepted, and the audience they must carry. */
  readonly oidcIssuer: string;
  readonly oidcAudience: string;

  /** Updates between snapshots. A snapshot is a materialisation, never a source of truth. */
  readonly snapshotEvery: number;
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
    oidcIssuer: stripTrailingSlash(required(env, 'NIX_COLLAB_OIDC_ISSUER')),
    oidcAudience: required(env, 'NIX_COLLAB_OIDC_AUDIENCE'),
    snapshotEvery: Number(env.NIX_COLLAB_SNAPSHOT_EVERY ?? 50),
  };
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
