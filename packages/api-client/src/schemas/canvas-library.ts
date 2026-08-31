/**
 * A principal's own canvas library: reusable native shapes carried into every canvas.
 *
 * `items` is `unknown[]` so the API can preserve forward-compatible native library entries without
 * coupling Core to the editor's shape schema. The web editor validates the native versioned
 * document before it renders or instantiates an entry.
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
