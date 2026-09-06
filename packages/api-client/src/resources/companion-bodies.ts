import { z } from 'zod';
import {
  defineCommand,
  defineQuery,
  type QueryEndpoint,
  type CommandEndpoint,
} from '../endpoints.js';

const pageSchema = z.object({
  headSeq: z.string().regex(/^\d+$/),
  schemaVersion: z.number().int(),
  hasMore: z.boolean(),
  updates: z
    .array(z.object({ seq: z.string().regex(/^\d+$/), update: z.string().max(1400000) }))
    .max(500),
});

/** Same-origin collaboration proxy; never accepts a model-provided URL. */
export const bodyUpdates = (
  itemId: string,
  after: string,
): QueryEndpoint<z.infer<typeof pageSchema>> =>
  defineQuery({
    operation: 'companion.body.read',
    path: `/collab/documents/${z.uuid().parse(itemId)}/updates`,
    query: { after },
    schema: pageSchema,
    cacheKey: undefined,
  });

export const appendBodyUpdate = (
  itemId: string,
  update: string,
  clientId: string,
): CommandEndpoint<{ seq: string }> =>
  defineCommand({
    operation: 'companion.body.append',
    method: 'POST',
    path: `/collab/documents/${z.uuid().parse(itemId)}/updates`,
    body: { update, clientId },
    schema: z.object({ seq: z.string() }),
    invalidates: [],
  });
