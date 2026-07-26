/**
 * Access-token supply and refresh coordination.
 *
 * This package does not do OIDC. Tokens arrive through an injected
 * `TokenProvider` that the OIDC layer implements later; all this layer knows is
 * "give me a token" and "that token was rejected, get me another". That keeps
 * the transport testable with a two-line fake and keeps Zitadel-isms - or any
 * other IdP's - out of the request path.
 *
 * Tokens live in memory. Nothing here reads or writes `localStorage`,
 * `sessionStorage`, cookies or any other persistent store, and
 * `createInMemoryTokenStore` exists so nobody is tempted to invent one.
 *
 * The bug this file exists to prevent is the refresh stampede. When an access
 * token expires, every request in flight comes back 401 at roughly the same
 * moment. The naive handler refreshes once per failed request, which hammers
 * the IdP, and - with refresh-token rotation - invalidates the rotating token
 * mid-flight so most of those refreshes fail and the user is logged out for no
 * reason. So: concurrent 401s collapse into exactly one refresh. Every waiter
 * awaits that single promise and then retries its own request once.
 *
 * Two further details matter for correctness:
 *
 *   - A request that 401s with a token that has *already* been replaced does
 *     not trigger a refresh at all; it simply retries with the current token.
 *     Without this, a second wave of stampede follows the first.
 *   - The shared refresh never inherits a caller's AbortSignal. One view
 *     unmounting must not cancel the refresh that every other view is waiting
 *     on; cancellation applies to the caller's own request only.
 */

import type { HttpRequest, HttpResponse, HttpTransport } from './http.js';

/**
 * Supplies access tokens to the transport. Implemented by the OIDC layer in a
 * later goal, and by `createInMemoryTokenStore` for tests and simple hosts.
 */
export interface TokenProvider {
  /** The current access token, or null when the session is anonymous. */
  getAccessToken(): string | null | Promise<string | null>;
  /**
   * Obtains a fresh access token. Called at most once per stampede - the
   * coordinator guarantees it - and never with a caller's AbortSignal.
   * Returns null when the session cannot be renewed, which surfaces the
   * original 401 to the caller.
   */
  refreshAccessToken(): Promise<string | null>;
}

export interface TokenStore extends TokenProvider {
  setAccessToken(token: string | null): void;
  clear(): void;
}

export interface InMemoryTokenStoreOptions {
  /**
   * Performs the actual renewal. In production this is the OIDC layer's silent
   * renew; in tests it is a call to the fake refresh endpoint.
   */
  readonly refresh: () => Promise<string | null>;
  readonly initialAccessToken?: string | null | undefined;
}

export function createInMemoryTokenStore(options: InMemoryTokenStoreOptions): TokenStore {
  let accessToken: string | null = options.initialAccessToken ?? null;
  return {
    getAccessToken: (): string | null => accessToken,
    refreshAccessToken: async (): Promise<string | null> => {
      accessToken = await options.refresh();
      return accessToken;
    },
    setAccessToken: (token: string | null): void => {
      accessToken = token;
    },
    clear: (): void => {
      accessToken = null;
    },
  };
}

/** Collapses concurrent refresh attempts into one shared in-flight promise. */
export interface RefreshCoordinator {
  refresh(): Promise<string | null>;
  /** Visible for diagnostics: whether a refresh is currently in flight. */
  readonly pending: boolean;
}

export function createRefreshCoordinator(
  refresh: () => Promise<string | null>,
): RefreshCoordinator {
  let inFlight: Promise<string | null> | null = null;

  return {
    get pending(): boolean {
      return inFlight !== null;
    },
    refresh(): Promise<string | null> {
      // Everyone who arrives while a refresh is running gets that same promise.
      inFlight ??= refresh().then(
        (token) => {
          inFlight = null;
          return token;
        },
        (error: unknown) => {
          inFlight = null;
          throw error;
        },
      );
      return inFlight;
    },
  };
}

export interface AuthenticationOptions {
  readonly tokens: TokenProvider;
  /** Authorization scheme. Bearer unless a host has a very good reason. */
  readonly scheme?: string | undefined;
  /** Share a coordinator across transports when a host builds more than one. */
  readonly coordinator?: RefreshCoordinator | undefined;
}

const AUTHORIZATION_HEADER = 'Authorization';

function authorized(request: HttpRequest, token: string | null, scheme: string): HttpRequest {
  if (token === null) return request;
  return {
    ...request,
    headers: { ...request.headers, [AUTHORIZATION_HEADER]: `${scheme} ${token}` },
  };
}

/**
 * Attaches the access token and retries once, after a single-flight refresh,
 * when the response is 401. A 401 that survives the retry is returned as-is
 * for the error-mapping layer above to turn into a typed error.
 */
export function withAuthentication(
  inner: HttpTransport,
  options: AuthenticationOptions,
): HttpTransport {
  const scheme = options.scheme ?? 'Bearer';
  const tokens = options.tokens;
  const coordinator =
    options.coordinator ?? createRefreshCoordinator(() => tokens.refreshAccessToken());

  return {
    async send(request: HttpRequest): Promise<HttpResponse> {
      const attempted = await tokens.getAccessToken();
      const response = await inner.send(authorized(request, attempted, scheme));
      if (response.status !== 401) return response;

      const current = await tokens.getAccessToken();
      const replaced = current !== null && current !== attempted;
      const token = replaced ? current : await coordinator.refresh();
      if (token === null) return response;

      return inner.send(authorized(request, token, scheme));
    },
  };
}
