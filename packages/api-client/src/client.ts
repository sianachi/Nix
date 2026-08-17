/**
 * The client: the four layers assembled into one object.
 *
 * Construction order is the request pipeline, innermost first: the axios
 * transport, then authentication (attach token, single-flight refresh on 401),
 * then error mapping (RFC 9457 to NixApiError, telemetry). Above that sits the
 * cache for reads, and boundary parsing on every payload that comes back.
 *
 * What a caller can do with this object is deliberately narrow. There is no
 * `request(method, url)` escape hatch, no axios instance to reach, and no
 * options bag of magic strings: every call is an endpoint descriptor whose
 * type determines the result type. Per-resource modules (`src/resources/`,
 * a later goal) are thin factories over `defineQuery` / `defineCommand`, so
 * the surface grows in typed methods rather than in options.
 *
 * Every call path takes an AbortSignal, including each page of a paginated
 * walk, so an unmounting view cancels the work it started.
 */

import {
  createServerCache,
  type CacheKey,
  type ServerCache,
  type ServerCacheOptions,
} from './cache.js';
import {
  type BinaryQueryEndpoint,
  type CommandEndpoint,
  type PagedQueryEndpoint,
  type QueryEndpoint,
  type QueryParameters,
} from './endpoints.js';
import {
  createHttpTransport,
  withErrorMapping,
  type HttpMethod,
  type HttpTransport,
} from './http.js';
import { withAuthentication, type TokenProvider } from './auth.js';
import { parseAtBoundary } from './parse.js';
import { CURSOR_PARAM, PAGE_SIZE_PARAM, cursorPageSchema } from './schemas/pagination.js';
import type { NixTelemetry } from './telemetry.js';
import type { CursorPage } from './schemas/pagination.js';
import { z } from 'zod';

export interface NixClientConfig {
  /** Absolute base URL of Core. Comes from validated boot configuration. */
  readonly baseUrl: string;
  /** Supplies access tokens; implemented by the OIDC layer. */
  readonly tokens: TokenProvider;
  readonly timeoutMs?: number | undefined;
  readonly defaultHeaders?: Readonly<Record<string, string>> | undefined;
  readonly telemetry?: NixTelemetry | undefined;
  readonly cache?: ServerCacheOptions | undefined;
}

export interface CallOptions {
  readonly signal?: AbortSignal | undefined;
  /** Ignore any cached value and go to Core. Still de-duplicated. */
  readonly forceRefresh?: boolean | undefined;
}

export interface QueryResult<TData> {
  readonly data: TData;
  readonly servedFromCache: boolean;
  /**
   * Non-null when a stale value was served and a refresh is running behind it.
   * A view can render "showing cached data, refreshing" honestly instead of
   * pretending the value is current.
   */
  readonly revalidation: Promise<void> | null;
}

export interface BinaryResult {
  readonly blob: Blob;
  readonly headers: Readonly<Record<string, string>>;
}

export interface NixClient {
  /** Server state, for subscription and for the invalidation channel. */
  readonly cache: ServerCache;
  /** Executes a read and returns the parsed result. */
  query<TResult>(endpoint: QueryEndpoint<TResult>, options?: CallOptions): Promise<TResult>;
  /** Same read, plus whether it came from cache and what is happening behind it. */
  queryResult<TResult>(
    endpoint: QueryEndpoint<TResult>,
    options?: CallOptions,
  ): Promise<QueryResult<TResult>>;
  /** Executes a write and applies its declared invalidations on success. */
  execute<TResult>(endpoint: CommandEndpoint<TResult>, options?: CallOptions): Promise<TResult>;
  /** Downloads an authenticated binary response through the same refusal and cancellation path. */
  download(endpoint: BinaryQueryEndpoint, options?: CallOptions): Promise<BinaryResult>;
  /** Walks a cursor-paginated collection item by item. */
  paginate<TItem>(
    endpoint: PagedQueryEndpoint<TItem>,
    options?: CallOptions,
  ): AsyncGenerator<TItem, void, undefined>;
  /** Marks every cache entry under this key prefix stale. */
  invalidate(prefix: CacheKey): void;
}

function requestCacheKey(
  operation: string,
  path: string,
  query: QueryParameters | undefined,
): CacheKey {
  if (query === undefined) return [operation, path];
  const canonical = Object.entries(query)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${String(value)}`)
    .join('&');
  return canonical === '' ? [operation, path] : [operation, path, canonical];
}

export function createNixClient(config: NixClientConfig): NixClient {
  const telemetry = config.telemetry;
  const transport: HttpTransport = withErrorMapping(
    withAuthentication(
      createHttpTransport({
        baseUrl: config.baseUrl,
        timeoutMs: config.timeoutMs,
        defaultHeaders: config.defaultHeaders,
      }),
      { tokens: config.tokens },
    ),
    telemetry,
  );
  const cache = createServerCache({ ...config.cache, telemetry });

  async function sendAndParse<TResult>(
    method: HttpMethod,
    path: string,
    query: QueryParameters | undefined,
    body: unknown,
    schema: z.ZodType<TResult>,
    operation: string,
    signal: AbortSignal | undefined,
    headers: Readonly<Record<string, string>> | undefined,
  ): Promise<TResult> {
    const response = await transport.send({ method, path, query, body, signal, headers });
    return parseAtBoundary(schema, response.body, {
      operation,
      status: response.status,
      telemetry,
    });
  }

  async function queryResult<TResult>(
    endpoint: QueryEndpoint<TResult>,
    options: CallOptions = {},
  ): Promise<QueryResult<TResult>> {
    const key =
      endpoint.cacheKey ?? requestCacheKey(endpoint.operation, endpoint.path, endpoint.query);
    return cache.read<TResult>(
      key,
      (signal) =>
        sendAndParse(
          'GET',
          endpoint.path,
          endpoint.query,
          undefined,
          endpoint.schema,
          endpoint.operation,
          signal,
          undefined,
        ),
      {
        signal: options.signal,
        forceRefresh: options.forceRefresh,
        staleAfterMs: endpoint.staleAfterMs,
      },
    );
  }

  return {
    cache,

    queryResult,

    async query<TResult>(
      endpoint: QueryEndpoint<TResult>,
      options: CallOptions = {},
    ): Promise<TResult> {
      const result = await queryResult(endpoint, options);
      return result.data;
    },

    async execute<TResult>(
      endpoint: CommandEndpoint<TResult>,
      options: CallOptions = {},
    ): Promise<TResult> {
      const result = await sendAndParse(
        endpoint.method,
        endpoint.path,
        endpoint.query,
        endpoint.body,
        endpoint.schema,
        endpoint.operation,
        options.signal,
        endpoint.headers,
      );
      for (const prefix of endpoint.invalidates) cache.invalidatePrefix(prefix);
      return result;
    },

    async download(
      endpoint: BinaryQueryEndpoint,
      options: CallOptions = {},
    ): Promise<BinaryResult> {
      const response = await transport.send({
        method: 'GET',
        path: endpoint.path,
        query: endpoint.query,
        responseType: 'blob',
        signal: options.signal,
      });
      const blob = parseAtBoundary(z.instanceof(Blob), response.body, {
        operation: endpoint.operation,
        status: response.status,
        telemetry,
      });
      return { blob, headers: response.headers };
    },

    async *paginate<TItem>(
      endpoint: PagedQueryEndpoint<TItem>,
      options: CallOptions = {},
    ): AsyncGenerator<TItem, void, undefined> {
      const pageSchema = cursorPageSchema(endpoint.itemSchema) as unknown as z.ZodType<
        CursorPage<TItem>
      >;
      let cursor: string | null = null;
      do {
        const page: CursorPage<TItem> = await sendAndParse(
          'GET',
          endpoint.path,
          {
            ...endpoint.query,
            [PAGE_SIZE_PARAM]: endpoint.pageSize,
            [CURSOR_PARAM]: cursor ?? undefined,
          },
          undefined,
          pageSchema,
          endpoint.operation,
          options.signal,
          undefined,
        );
        yield* page.items;
        cursor = page.nextCursor;
      } while (cursor !== null);
    },

    invalidate(prefix: CacheKey): void {
      cache.invalidatePrefix(prefix);
    },
  };
}
