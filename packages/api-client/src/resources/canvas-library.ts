/**
 * The caller's own canvas library: the only place its URL appears.
 *
 * One library per principal, carried into every canvas they open in every workspace - not scoped
 * by item or workspace, the way `GET /api/v1/me` is not.
 */

import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import { canvasLibrarySchema, type CanvasLibrary } from '../schemas/index.js';

const CANVAS_LIBRARY_KEY = ['me', 'canvas-library'] as const;

/** The caller's own canvas library, empty when nothing has been saved yet. */
export const canvasLibrary = (): QueryEndpoint<CanvasLibrary> =>
  defineQuery<CanvasLibrary>({
    operation: 'canvasLibrary.get',
    path: '/api/v1/me/canvas-library',
    schema: canvasLibrarySchema,
    cacheKey: CANVAS_LIBRARY_KEY,
  });

/**
 * Replaces the caller's library wholesale.
 *
 * `items` is the library's complete new contents, matching what Excalidraw's own
 * `onLibraryChange` hands back - always everything, never a delta.
 */
export const saveCanvasLibrary = (items: readonly unknown[]): CommandEndpoint<CanvasLibrary> =>
  defineCommand<CanvasLibrary>({
    operation: 'canvasLibrary.save',
    method: 'PUT',
    path: '/api/v1/me/canvas-library',
    schema: canvasLibrarySchema,
    body: { items },
    invalidates: [CANVAS_LIBRARY_KEY],
  });
