/**
 * The media service's configuration.
 *
 * Hand-rolled and fail-fast, matching the collaboration service: every value is read once at
 * start-up and a missing one refuses to boot with a sentence saying which. A service that starts
 * without knowing where Core is, and discovers it on the first request, fails in front of a user
 * instead of in front of whoever deployed it.
 *
 * **There is no OIDC configuration here, and that is the design.** This service validates no
 * tokens. It forwards the caller's, and the collaboration service authorizes it through Core - so
 * there is one authorization code path in the system rather than a second JWKS cache and a second
 * issuer list to drift apart. See `http/server.ts`.
 */

export interface MediaConfig {
  readonly port: number;
  readonly host: string;

  /** Where the item bundles come from. This service reads documents from nowhere else. */
  readonly collabBaseUrl: string;

  /** Presented on every internal call, to say which service is asking. */
  readonly internalSecret: string;

  /** How long one conversion may take before it is abandoned. */
  readonly jobTimeoutMs: number;

  /** How large a produced file may get before the export is refused rather than filling memory. */
  readonly maxOutputBytes: number;

  /** How much bundle stream may be read before the same. */
  readonly maxBundleBytes: number;

  /** How many conversions may run at once. A CPU-bound renderer with no gate is how this dies. */
  readonly maxConcurrentExports: number;

  readonly logLevel: string;
}

/**
 * Environment variables this service must never be given.
 *
 * **The executable form of "Media has no database credentials, ever."** That rule is stated in
 * CLAUDE.md and in the development document, and a rule that lives only in prose is one that gets
 * copy-pasted away - a deployment manifest cloned from the collaboration service's is exactly the
 * shape of that mistake, and it would hand the process that parses untrusted files a connection to
 * the item store. Refusing to start is loud, immediate, and impossible to miss in a rollout.
 *
 * This is the mirror of the collaboration service's `assertRuntimeRole`, which refuses roles that
 * would make its isolation policies decorative.
 */
const FORBIDDEN_PATTERN = /DATABASE|CONNECTION_STRING|PGPASSWORD|PGHOST|PGUSER/;

/** Names that are forbidden outright, whatever prefix they carry. */
const FORBIDDEN_NAMES = ['DATABASE_URL', 'PGHOST', 'PGPASSWORD', 'PGUSER', 'PGDATABASE'] as const;

export function assertNoDatabaseCredentials(env: NodeJS.ProcessEnv): void {
  for (const name of FORBIDDEN_NAMES) {
    if (env[name] !== undefined && env[name] !== '') {
      throw new Error(
        `${name} is set. The media service holds no database credentials, ever - it reads documents ` +
          'through the collaboration service and reports through Core. Remove it before starting.',
      );
    }
  }

  for (const name of Object.keys(env)) {
    if (name.startsWith('NIX_MEDIA_') && FORBIDDEN_PATTERN.test(name)) {
      throw new Error(
        `${name} looks like a database credential. The media service holds none, ever - it reads ` +
          'documents through the collaboration service and reports through Core.',
      );
    }
  }
}

export function readConfig(env: NodeJS.ProcessEnv): MediaConfig {
  assertNoDatabaseCredentials(env);

  return {
    port: Number(env.NIX_MEDIA_PORT ?? 8200),
    host: env.NIX_MEDIA_HOST ?? '0.0.0.0',
    collabBaseUrl: stripTrailingSlash(required(env, 'NIX_MEDIA_COLLAB_BASE_URL')),
    internalSecret: required(env, 'NIX_MEDIA_INTERNAL_SECRET'),
    jobTimeoutMs: Number(env.NIX_MEDIA_JOB_TIMEOUT_MS ?? 30_000),
    maxOutputBytes: Number(env.NIX_MEDIA_MAX_OUTPUT_MB ?? 64) * 1024 * 1024,
    maxBundleBytes: Number(env.NIX_MEDIA_MAX_BUNDLE_MB ?? 64) * 1024 * 1024,
    maxConcurrentExports: Number(env.NIX_MEDIA_MAX_CONCURRENT_EXPORTS ?? 4),
    logLevel: env.NIX_MEDIA_LOG_LEVEL ?? 'info',
  };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];

  if (value === undefined || value === '') {
    throw new Error(`${key} is required. The media service will not start without it.`);
  }

  return value;
}

/**
 * A base URL with no trailing slash, so paths concatenate onto it predictably.
 *
 * Every call site writes `${base}/documents/...`, and a configured value ending in a slash would
 * produce a double one - which some proxies normalise and some answer 404 to.
 */
function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
