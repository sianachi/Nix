import type { UserManagerSettings } from 'oidc-client-ts';

/**
 * How the browser talks to the tenant's identity provider.
 *
 * Read from Vite environment variables rather than hard-coded, because the issuer is per-deployment
 * and, in development, per-machine: `deploy/seed/zitadel-configure.sh` writes the generated issuer
 * and client id to `deploy/.zitadel/oidc.generated.env` after Zitadel bootstraps, and those values
 * differ for every developer.
 */

/** The dev defaults match the Zitadel in `deploy/compose.dev.yml`. */
const DEV_ISSUER = 'http://localhost:8080';

export interface OidcEnvironment {
  readonly issuer: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly postLogoutRedirectUri: string;
  readonly silentRedirectUri: string;
}

/** Whether enough configuration exists to attempt a sign-in at all. */
export function isOidcConfigured(environment: OidcEnvironment): boolean {
  return environment.issuer.length > 0 && environment.clientId.length > 0;
}

export function readOidcEnvironment(env: ImportMetaEnv, origin: string): OidcEnvironment {
  // Vite types unknown VITE_* keys as `any`; read them through an index signature and narrow, so a
  // missing or mistyped variable becomes an empty string here rather than an `any` that flows into
  // the user manager's settings.
  const values: Record<string, unknown> = env;
  const readString = (key: string, fallback: string): string =>
    typeof values[key] === 'string' && values[key].length > 0 ? values[key] : fallback;

  return {
    issuer: readString('VITE_OIDC_ISSUER', DEV_ISSUER),
    clientId: readString('VITE_OIDC_CLIENT_ID', ''),
    redirectUri: `${origin}/auth/callback`,
    postLogoutRedirectUri: `${origin}/`,
    silentRedirectUri: `${origin}/auth/silent-renew`,
  };
}

/**
 * Builds the settings `UserManager` runs on.
 *
 * Three choices here are security decisions rather than preferences:
 *
 * - **Authorization code with PKCE**, never implicit. An access token in a URL fragment lands in
 *   browser history and in any referrer that leaks; a code exchange keeps it out of both.
 * - **Tab-scoped token persistence.** oidc-client-ts keeps its user (including the access token) in
 *   `sessionStorage` by default. A reload in the same tab restores immediately, while closing the
 *   tab ends that persistence. Nix does not copy the token into application state or localStorage.
 * - **Silent renew on**, so a five-to-fifteen minute access token is refreshed without interrupting
 *   the person using the application, and a revoked session stops working promptly rather than at
 *   the end of a long-lived token's life.
 */
export function buildUserManagerSettings(environment: OidcEnvironment): UserManagerSettings {
  return {
    authority: environment.issuer,
    client_id: environment.clientId,
    redirect_uri: environment.redirectUri,
    post_logout_redirect_uri: environment.postLogoutRedirectUri,
    silent_redirect_uri: environment.silentRedirectUri,

    response_type: 'code',
    scope: 'openid profile email offline_access',

    automaticSilentRenew: true,
    monitorSession: false,

    // `userStore` is deliberately left unset to retain oidc-client-ts's default
    // WebStorageStateStore backed by sessionStorage. It contains the serialized User, including
    // tokens, for this tab only. The library's separate transient state store also uses
    // sessionStorage so the PKCE verifier and nonce survive the redirect navigation.
    loadUserInfo: true,
  };
}
