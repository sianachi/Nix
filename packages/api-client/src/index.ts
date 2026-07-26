/**
 * The public surface of @nix/api-client.
 *
 * What is deliberately absent is the point of this file: no axios instance, no
 * axios types, no interceptor registry, no generic `request(method, url)`, no
 * options bag of magic strings. A consumer can create a client, describe
 * endpoints, execute them with cancellation, observe cache state and branch on
 * typed errors - and nothing else.
 *
 * Everything a caller receives has already been parsed against a Zod schema at
 * the boundary and deep-frozen. Nothing downstream re-validates.
 *
 * Later goals extend this surface by adding `src/generated/` (types generated
 * from Core's OpenAPI document) and `src/resources/` (typed per-resource
 * methods built from `defineQuery` / `defineCommand`), which are then exposed
 * here as `client.items`, `client.search` and so on. The transport, auth,
 * error, schema and cache layers below them do not change.
 */

export { createNixClient } from './client.js';
export type { CallOptions, NixClient, NixClientConfig, QueryResult } from './client.js';

export { defineCommand, definePagedQuery, defineQuery } from './endpoints.js';
export type {
  CommandEndpoint,
  CommandMethod,
  CommandSpec,
  PagedQueryEndpoint,
  PagedQuerySpec,
  QueryEndpoint,
  QueryParameters,
  QuerySpec,
} from './endpoints.js';

export {
  NixApiError,
  NixErrorCode,
  NixErrorKind,
  httpStatusCode,
  isCanceledError,
  isNixApiError,
} from './errors.js';
export type { NixApiErrorOptions } from './errors.js';

export { createInMemoryTokenStore, createRefreshCoordinator } from './auth.js';
export type { RefreshCoordinator, TokenProvider, TokenStore } from './auth.js';

export { cacheKeyToString, createMemoryCacheStore } from './cache.js';
export type {
  CacheEntry,
  CacheKey,
  CacheReadOptions,
  CacheReadResult,
  CacheStore,
  ServerCache,
  ServerCacheOptions,
} from './cache.js';

export type {
  CacheRevalidateErrorEvent,
  NixTelemetry,
  ParseErrorEvent,
  ParseIssue,
  RequestErrorEvent,
} from './telemetry.js';

export {
  CURSOR_PARAM,
  PAGE_SIZE_PARAM,
  cursorPageSchema,
  itemKindSchema,
  itemSchema,
  noContentSchema,
  problemDetailsSchema,
} from './schemas/index.js';
export type { CursorPage, Item, ItemKind, ProblemDetails } from './schemas/index.js';
