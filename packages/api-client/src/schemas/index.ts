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

/**
 * Response schema for endpoints that answer 204 No Content. The transport
 * normalises an empty body to `undefined` before parsing, so this is the
 * honest type for "succeeded, returned nothing".
 */
export const noContentSchema = z.undefined();
