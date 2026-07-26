/**
 * Zod schemas for every API boundary shape.
 *
 * Generated OpenAPI types land next to this directory (`src/generated/`) in a
 * later goal; schemas here then assert structural agreement with them via
 * `satisfies`. Nothing in this directory imports transport code, so schemas
 * stay usable from tests, mocks and MSW handlers.
 */

import { z } from 'zod';

export { problemDetailsSchema, type ProblemDetails } from './problem-details.js';
export { cursorPageSchema, CURSOR_PARAM, PAGE_SIZE_PARAM, type CursorPage } from './pagination.js';
export { itemSchema, itemKindSchema, type Item, type ItemKind } from './item.js';

/**
 * Response schema for endpoints that answer 204 No Content. The transport
 * normalises an empty body to `undefined` before parsing, so this is the
 * honest type for "succeeded, returned nothing".
 */
export const noContentSchema = z.undefined();
