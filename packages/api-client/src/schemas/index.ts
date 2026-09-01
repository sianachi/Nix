/**
 * Zod schemas for every API boundary shape.
 *
 * Generated OpenAPI types live next to this directory in `src/generated/`, refreshed with
 * `pnpm --filter @nix/api-client generate` whenever Core announces a contract change. Every
 * schema here asserts structural agreement with them via `satisfies`, so a backend rename is a
 * build failure in this package rather than a runtime surprise in a component.
 *
 * Nothing in this directory imports transport code, so schemas stay usable from tests, mocks and
 * MSW handlers.
 */

import { z } from 'zod';

export { problemDetailsSchema, type ProblemDetails } from './problem-details.js';
export { cursorPageSchema, CURSOR_PARAM, PAGE_SIZE_PARAM, type CursorPage } from './pagination.js';
export {
  itemSchema,
  itemTypeSchema,
  itemLifecycleStateSchema,
  itemSequenceSchema,
  KNOWN_ITEM_TYPES,
  type Item,
  type KnownItemType,
} from './item.js';
export { canvasLibrarySchema, type CanvasLibrary } from './canvas-library.js';
export {
  graphLinkSchema,
  graphNodeSchema,
  workspaceGraphSchema,
  type GraphLink,
  type GraphNode,
  type WorkspaceGraph,
} from './workspace-graph.js';
export {
  calendarEntryKindSchema,
  calendarEntrySchema,
  unplaceableCalendarSchema,
  workspaceCalendarSchema,
  type CalendarEntry,
  type CalendarEntryKind,
  type UnplaceableCalendar,
  type WorkspaceCalendar,
} from './workspace-calendar.js';
export { keptItemSchema, shelfSchema, type KeptItem, type Shelf } from './bookmarks.js';
export { currentPrincipalSchema, type CurrentPrincipal } from './current-principal.js';
export {
  backlinkSchema,
  backlinksSchema,
  referenceResolutionSchema,
  referencesSchema,
  type Backlink,
  type Backlinks,
  type ReferenceResolution,
  type References,
} from './references.js';
export {
  dailyNoteSchema,
  workspaceInvitationSchema,
  workspaceInviteeSchema,
  workspaceMemberSchema,
  workspaceSchema,
  type DailyNote,
  type Workspace,
  type WorkspaceInvitation,
  type WorkspaceInvitee,
  type WorkspaceMember,
} from './workspaces.js';
export {
  containerViewConfigurationsSchema,
  containerViewsSchema,
  viewSummarySchema,
  type ContainerViewConfigurations,
  type ContainerViews,
  type ViewSummary,
} from './views.js';
export {
  effectiveSchemaSchema,
  propertyDefinitionSchema,
  type EffectiveSchema,
  type PropertyDefinition,
} from './structure.js';
export {
  searchHitSchema,
  searchResultsSchema,
  type SearchHit,
  type SearchResults,
} from './search.js';
export {
  ACCESS_TOKEN_SCOPES,
  accessTokenListSchema,
  accessTokenSchema,
  createdAccessTokenSchema,
  tokenExchangeResponseSchema,
  type AccessToken,
  type AccessTokenList,
  type CreatedAccessToken,
  type TokenExchangeResponse,
} from './access-tokens.js';
export {
  chartBucketSchema,
  itemChartSchema,
  type ChartBucket,
  type ItemChart,
} from './item-chart.js';
export {
  itemQueryResultsSchema,
  queryResultSchema,
  type ItemQueryResults,
  type QueryResultRow,
} from './item-query.js';
export {
  templateCapabilitiesSchema,
  templateCatalogSchema,
  templateDetailSchema,
  templateItemSchema,
  templateOriginSchema,
  templatePreflightInputSchema,
  templatePreflightRequestSchema,
  templatePreflightSchema,
  templateSummarySchema,
  type TemplateCatalog,
  type TemplateDetail,
  type TemplateItem,
  type TemplatePreflight,
  type TemplatePreflightInput,
  type TemplateSummary,
} from './templates.js';
export {
  templateImportDigestSchema,
  templateImportPreviewSchema,
  templateImportProfileSchema,
  templateImportResultSchema,
  templateImportSchema,
  templateImportUploadSchema,
  type TemplateImport,
  type TemplateImportPreview,
  type TemplateImportProfile,
  type TemplateImportResult,
  type TemplateImportUpload,
} from './template-imports.js';
export {
  completeOccurrenceResultSchema,
  recurrenceFreqSchema,
  recurrenceRuleSchema,
  recurrenceWeekdaySchema,
  setRecurrenceResultSchema,
  type CompleteOccurrenceResult,
  type RecurrenceFreq,
  type RecurrenceRule,
  type RecurrenceWeekday,
  type SetRecurrenceResult,
} from './recurrence.js';
export {
  fileRecordSchema,
  fileUploadSchema,
  fileVersionSchema,
  type FileRecord,
  type FileUpload,
  type FileVersion,
} from './files.js';
export {
  exportDownloadCapabilitySchema,
  exportFormatCatalogSchema,
  exportFormatSchema,
  exportSchema,
  exportStatusSchema,
  type Export,
  type ExportDownloadCapability,
  type ExportFormat,
  type ExportFormatCatalog,
  type ExportStatus,
} from './exports.js';

/**
 * Response schema for endpoints that answer 204 No Content. The transport
 * normalises an empty body to `undefined` before parsing, so this is the
 * honest type for "succeeded, returned nothing".
 */
export const noContentSchema = z.undefined();
