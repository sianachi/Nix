/**
 * A principal's own canvas library: the reusable Excalidraw shapes carried into every canvas.
 *
 * `items` is `unknown[]`, not a shape-by-shape schema. Core stores and returns exactly what
 * Excalidraw's own `libraryItems` shape is and never inspects a single field of it - the boundary's
 * job is to prove the response is an array, not to know what a library item contains, which is a
 * fact that belongs to the Excalidraw version this build ships, not to the API contract.
 */

import { z } from 'zod';
import type { components } from '../generated/api.js';

export const canvasLibrarySchema = z.object({
  items: z.array(z.unknown()),
});

export type CanvasLibrary = z.infer<typeof canvasLibrarySchema>;

const _canvasLibraryContract = canvasLibrarySchema satisfies z.ZodType<
  components['schemas']['CanvasLibraryResponse']
>;
void _canvasLibraryContract;
