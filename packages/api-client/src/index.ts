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
  itemTypeSchema,
  itemLifecycleStateSchema,
  itemSequenceSchema,
  KNOWN_ITEM_TYPES,
  itemSchema,
  noContentSchema,
  problemDetailsSchema,
  graphNodeSchema,
  graphLinkSchema,
  workspaceCalendarSchema,
  workspaceGraphSchema,
} from './schemas/index.js';
export type {
  CursorPage,
  CalendarEntry,
  CalendarEntryKind,
  GraphLink,
  GraphNode,
  Item,
  KnownItemType,
  ProblemDetails,
  UnplaceableCalendar,
  WorkspaceCalendar,
  WorkspaceGraph,
} from './schemas/index.js';

/**
 * Contract types, named one at a time, so a boundary schema living outside this package can tie
 * itself to the same source of truth with `satisfies`.
 *
 * The `components` map itself stays private, deliberately. Re-exporting it wholesale would make
 * every schema Core has - and every schema Core grows next - public API of this package the moment
 * `generate` runs, with nothing in between to notice. That contradicts the whole point of the file
 * you are reading. Adding a line here is the friction, and the friction is the feature: it is the
 * one place someone sees that a boundary schema has taken root outside the package that owns
 * boundaries, and can ask whether it should move in.
 *
 * Type-only. The generated file is rewritten wholesale by
 * `pnpm --filter @nix/api-client generate` and is not an editable surface.
 */
export type {
  CanvasLibraryContract,
  ContainerViewsContract,
  CurrentPrincipalContract,
  EffectiveSchemaContract,
  PropertyDefinitionContract,
  ViewContract,
} from './contracts.js';

/**
 * Per-resource methods: the only place API paths appear. A caller builds a descriptor and hands it
 * to the client, so nothing above this package ever sees a URL.
 */
export * as items from './resources/items.js';
export * as canvasLibrary from './resources/canvas-library.js';
export * as workspaceCalendar from './resources/workspace-calendar.js';
export * as workspaceGraph from './resources/workspace-graph.js';
