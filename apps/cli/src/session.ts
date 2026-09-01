/**
 * A run's authenticated session: the personal access token exchanged for a short-lived JWT, and a
 * Nix client that carries it.
 *
 * **The personal access token never leaves this process to anywhere but Core's exchange, and the
 * JWT it buys is what everything downstream sees.** That is the same shape the web application's
 * sessions have and the same one the collaboration service already validates, so the CLI is a
 * client of the API rather than a second thing to authorize. The exchange is re-minted when
 * the JWT is close to expiring and, as a fallback, whenever a request comes back 401 - the
 * api-client's own single-flight refresh collapses a burst of those into one exchange.
 *
 * This is the first production host of `createNixClient`: the web application still talks to Core
 * with raw fetch, so the descriptor executor, its cache and this refresh path run here for real
 * rather than only in tests.
 */

import { createNixClient, type NixClient, type TokenProvider } from '@nix/api-client';
import type { Profile } from './config.ts';

/** How close to expiry the JWT may drift before a read re-mints it, rather than risking a 401. */
const REFRESH_SKEW_MS = 30_000;

/** The exchange response, `POST /public/v1/auth/token`. */
interface ExchangeResponse {
  readonly accessToken: string;
  readonly tokenType: string;
  readonly expiresInSeconds: number;
}

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface SessionOptions {
  readonly profile: Profile;
  readonly now?: () => number;
  readonly fetchImpl?: FetchImpl;
}

/**
 * Builds a token provider that mints a session from a personal access token and keeps it fresh.
 *
 * @param options The profile whose token is exchanged, plus a clock and fetch for tests.
 * @returns A {@link TokenProvider} the client authenticates every request with.
 */
export function createPatTokenProvider(options: SessionOptions): TokenProvider {
  const { profile } = options;
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  let accessToken: string | null = null;
  let expiresAt = 0;
  let inFlight: Promise<string | null> | null = null;

  const exchange = async (): Promise<string | null> => {
    const response = await fetchImpl(`${profile.apiUrl}/public/v1/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: profile.token }),
    });

    if (!response.ok) {
      // The exchange's own words carry the reason (revoked, expired, unconfigured); an HTTP failure
      // that is not a problem document is a proxy answering, and inventing a reason for it would be
      // a guess presented as fact.
      accessToken = null;
      expiresAt = 0;
      throw await exchangeError(response);
    }

    const body = (await response.json()) as ExchangeResponse;
    accessToken = body.accessToken;
    expiresAt = now() + body.expiresInSeconds * 1000;
    return accessToken;
  };

  // Single-flight: a burst of concurrent reads that all find the token stale must trigger one
  // exchange, not one each. Whoever arrives first owns the in-flight promise; the rest await it.
  const refresh = async (): Promise<string | null> => {
    if (inFlight !== null) {
      return inFlight;
    }
    inFlight = exchange().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return {
    getAccessToken: (): string | null | Promise<string | null> => {
      if (accessToken !== null && now() < expiresAt - REFRESH_SKEW_MS) {
        return accessToken;
      }
      return refresh();
    },
    refreshAccessToken: refresh,
  };
}

/**
 * The endpoints retained by a profile. New durable operations use Core; collaboration remains the
 * direct note-body boundary, and the media URL remains only for profile compatibility.
 */
export interface SessionEndpoints {
  readonly apiUrl: string;
  readonly collabUrl: string;
  readonly mediaUrl: string;
}

/** Resolves Core, collaboration, and the legacy media profile value. */
export function endpointsFor(profile: Profile): SessionEndpoints {
  return {
    apiUrl: profile.apiUrl,
    collabUrl: profile.collabUrl ?? deriveUrl(profile.apiUrl, 8100),
    mediaUrl: profile.mediaUrl ?? deriveUrl(profile.apiUrl, 8200),
  };
}

/** A run's client and the token provider behind it. */
export interface Session {
  readonly client: NixClient;
  readonly tokens: TokenProvider;
  readonly endpoints: SessionEndpoints;
}

/**
 * Opens a session for a profile: the token provider, and a Nix client that carries it.
 *
 * @param options The profile and test seams.
 * @returns The session.
 */
export function openSession(options: SessionOptions): Session {
  const tokens = createPatTokenProvider(options);
  const endpoints = endpointsFor(options.profile);
  // The resource descriptors carry the full `/api/v1/...` path, so the base is Core's origin.
  const client = createNixClient({ baseUrl: endpoints.apiUrl, tokens });
  return { client, tokens, endpoints };
}

/** The acting principal, as `/api/v1/me` reports them. */
export interface CurrentPrincipal {
  readonly id: string;
  readonly tenantId: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly isTenantAdministrator: boolean;
}

/**
 * Reads who the session acts as, which is also how `auth login` proves a token before storing it.
 *
 * Kept a raw read rather than a client descriptor so it exercises the exchange and the bearer path
 * end to end with nothing cached in front of it: a token that cannot mint a session, or mints one
 * a principal lookup refuses, fails here with Core's own words.
 *
 * @param session The open session.
 * @param fetchImpl The fetch to use; the session's default in production.
 * @returns The acting principal.
 */
export async function whoami(
  session: Session,
  fetchImpl: FetchImpl = globalThis.fetch,
): Promise<CurrentPrincipal> {
  const token = await session.tokens.getAccessToken();
  if (token === null) {
    throw new Error(
      'Could not obtain a session for this profile. Check the token with `nixctl auth login`.',
    );
  }

  const response = await fetchImpl(`${session.endpoints.apiUrl}/api/v1/me`, {
    headers: { authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw await exchangeError(response);
  }

  return (await response.json()) as CurrentPrincipal;
}

function deriveUrl(apiUrl: string, port: number): string {
  try {
    const url = new URL(apiUrl);
    url.port = String(port);
    // Strip any path; the service URLs are origins.
    return `${url.protocol}//${url.host}`;
  } catch {
    return apiUrl;
  }
}

async function exchangeError(response: Response): Promise<Error> {
  try {
    const body = (await response.json()) as { detail?: unknown; code?: unknown };
    if (typeof body.detail === 'string' && body.detail.length > 0) {
      return new Error(body.detail);
    }
  } catch {
    // Falls through to the status line below.
  }
  return new Error(`The session could not be minted (${String(response.status)}).`);
}
