import type { components } from './generated/api.js';

/**
 * The contract types this package publishes, one alias per schema.
 *
 * These exist so a boundary schema that lives outside this package can still be tied to the
 * generated contract with `satisfies z.ZodType<...>`, the way `schemas/item.ts` ties `itemSchema`.
 * The `components` map stays private: exporting it would hand every consumer every schema Core has
 * or will grow, and a schema would become public API of this package the moment `generate` ran,
 * with no review step anywhere in between.
 *
 * So each alias is added by hand, when something outside actually needs it. That is the point of
 * friction where somebody notices that a boundary schema has grown outside the package that owns
 * boundaries - which is usually a sign it should move in, not a sign this list should get longer.
 */

/** One view over a container's children, as `GET /items/{id}/views` returns it. */
export type ViewContract = components['schemas']['ViewResponse'];

/** A container's views, its unrenderable ones, and which of them opens by default. */
export type ContainerViewsContract = components['schemas']['ContainerViewsResponse'];

/** An item's property schema: what it declares, what it inherits, and the resolved result. */
export type EffectiveSchemaContract = components['schemas']['EffectiveSchemaResponse'];

/** One property in a schema: its key, its label, its type and whether it is required. */
export type PropertyDefinitionContract = components['schemas']['PropertyDefinitionResponse'];

/** The signed-in caller, as `GET /api/v1/me` returns it. */
export type CurrentPrincipalContract = components['schemas']['CurrentPrincipalResponse'];

/** The caller's own canvas library, as `GET /api/v1/me/canvas-library` returns it. */
export type CanvasLibraryContract = components['schemas']['CanvasLibraryResponse'];
