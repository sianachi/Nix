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
export type {
  BinaryResult,
  CallOptions,
  NixClient,
  NixClientConfig,
  QueryResult,
} from './client.js';

export { defineBinaryQuery, defineCommand, definePagedQuery, defineQuery } from './endpoints.js';
export type {
  BinaryQueryEndpoint,
  BinaryQuerySpec,
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
  itemChartSchema,
  itemQueryResultsSchema,
  itemSchema,
  noContentSchema,
  problemDetailsSchema,
  effectiveSchemaSchema,
  propertyDefinitionSchema,
  searchHitSchema,
  searchResultsSchema,
  graphNodeSchema,
  graphLinkSchema,
  shelfSchema,
  currentPrincipalSchema,
  backlinkSchema,
  backlinksSchema,
  referenceResolutionSchema,
  referencesSchema,
  templateCapabilitiesSchema,
  templateCatalogSchema,
  templateDetailSchema,
  templateImportDigestSchema,
  templateImportPreviewSchema,
  templateImportProfileSchema,
  templateImportResultSchema,
  templateImportSchema,
  templateImportUploadSchema,
  templateItemSchema,
  templateOriginSchema,
  templatePreflightInputSchema,
  templatePreflightRequestSchema,
  templatePreflightSchema,
  templateSummarySchema,
  workspaceCalendarSchema,
  workspaceGraphSchema,
  completeOccurrenceResultSchema,
  recurrenceFreqSchema,
  recurrenceRuleSchema,
  recurrenceWeekdaySchema,
  setRecurrenceResultSchema,
  dailyNoteSchema,
  workspaceInvitationSchema,
  workspaceMemberSchema,
  workspaceSchema,
} from './schemas/index.js';
export type {
  CursorPage,
  CalendarEntry,
  EffectiveSchema,
  ChartBucket,
  ItemChart,
  ItemQueryResults,
  PropertyDefinition,
  QueryResultRow,
  SearchHit,
  SearchResults,
  KeptItem,
  CalendarEntryKind,
  GraphLink,
  GraphNode,
  Item,
  KnownItemType,
  ProblemDetails,
  Shelf,
  CurrentPrincipal,
  Backlink,
  Backlinks,
  ReferenceResolution,
  References,
  TemplateCatalog,
  TemplateDetail,
  TemplateImport,
  TemplateImportPreview,
  TemplateImportProfile,
  TemplateImportResult,
  TemplateImportUpload,
  TemplateItem,
  TemplatePreflight,
  TemplatePreflightInput,
  TemplateSummary,
  UnplaceableCalendar,
  WorkspaceCalendar,
  WorkspaceGraph,
  CompleteOccurrenceResult,
  RecurrenceFreq,
  RecurrenceRule,
  RecurrenceWeekday,
  SetRecurrenceResult,
  DailyNote,
  Workspace,
  WorkspaceInvitation,
  WorkspaceInvitee,
  WorkspaceMember,
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
  ChangeWorkspaceMemberRoleRequestContract,
  ContainerViewsContract,
  CreateWorkspaceInvitationRequestContract,
  CreateWorkspaceRequestContract,
  DailyNoteContract,
  SetViewsRequestContract,
  StructuredItemContract,
  CurrentPrincipalContract,
  EffectiveSchemaContract,
  PropertyDefinitionContract,
  RecoverWorkspaceRequestContract,
  RenameWorkspaceRequestContract,
  TemplateCatalogContract,
  TemplateDetailContract,
  TemplateItemContract,
  TemplatePreflightContract,
  TemplatePreflightRequestContract,
  TemplateSummaryContract,
  ViewContract,
  ViewRequestContract,
  WorkspaceInvitationContract,
  WorkspaceInviteeContract,
  WorkspaceMemberContract,
} from './contracts.js';

/**
 * Per-resource methods: the only place API paths appear. A caller builds a descriptor and hands it
 * to the client, so nothing above this package ever sees a URL.
 */
export * as accessTokens from './resources/access-tokens.js';
export * as principal from './resources/principal.js';
export * as pets from './resources/pets.js';
export {
  petProfileSchema,
  petSettingsSchema,
  petSettingsResponseSchema,
  petConnectionSchema,
} from './schemas/pets.js';
export type {
  PetProfile,
  PetSettings,
  PetSettingsResponse,
  PetConnection,
  PetAction,
  PetMessage,
} from './schemas/pets.js';
export * as bookmarks from './resources/bookmarks.js';
export * as items from './resources/items.js';
export * as workspaces from './resources/workspaces.js';
export type { AssignableWorkspaceRole } from './resources/workspaces.js';
export * as views from './resources/views.js';
export * as structure from './resources/structure.js';
export * as search from './resources/search.js';
export * as references from './resources/references.js';
export * as canvasLibrary from './resources/canvas-library.js';
export * as itemChart from './resources/item-chart.js';
export * as itemQuery from './resources/item-query.js';
export * as workspaceCalendar from './resources/workspace-calendar.js';
export * as workspaceGraph from './resources/workspace-graph.js';
export * as templates from './resources/templates.js';
export * as templateImports from './resources/template-imports.js';
export type { BeginTemplateImportInput } from './resources/template-imports.js';
export * as recurrence from './resources/recurrence.js';
export * as files from './resources/files.js';
export * as imports from './resources/imports.js';
export * as operations from './resources/operations.js';
export * as exports from './resources/exports.js';
export * as plugins from './resources/plugins.js';
export type {
  FileDownloadCapability,
  FileRecord,
  FileUpload,
  FileUploadStatus,
  FileVersion,
} from './schemas/files.js';
export {
  fileDownloadCapabilitySchema,
  fileRecordSchema,
  fileUploadSchema,
  fileUploadStatusSchema,
  fileVersionSchema,
} from './schemas/files.js';
export type {
  DocumentImport,
  DocumentImportPlan,
  DocumentImportUpload,
} from './schemas/imports.js';
export type { Operation } from './schemas/operations.js';
export type {
  Export,
  ExportDownloadCapability,
  ExportFormat,
  ExportFormatCatalog,
  ExportStatus,
} from './schemas/exports.js';
export type {
  PluginCapability,
  PluginComponentUpload,
  PluginInstallation,
} from './schemas/plugins.js';
export {
  pluginCapabilitySchema,
  pluginComponentUploadSchema,
  pluginInstallationSchema,
} from './schemas/plugins.js';
export {
  exportDownloadCapabilitySchema,
  exportFormatCatalogSchema,
  exportFormatSchema,
  exportSchema,
  exportStatusSchema,
} from './schemas/exports.js';
export {
  runWorkspaceTool,
  workspaceToolSchema,
  WorkspaceToolRefusal,
  type CompanionBodies,
} from './companion-tools.js';
export * as companionBodies from './resources/companion-bodies.js';
export type { PetToolCall } from './schemas/pets.js';
