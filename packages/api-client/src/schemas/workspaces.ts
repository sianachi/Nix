/**
 * A workspace: a container of items, one of the several a tenant may hold.
 *
 * The schema is the source of truth and the type is `z.infer` of it; the `satisfies` line ties it
 * to the generated contract so a backend rename fails this package's build rather than a user's
 * request. The two quota fields arrive as strings because they are 64-bit and 32-bit integers the
 * JSON contract widens to `["integer","string"]` to survive a language whose numbers are not - so
 * they are carried as strings and parsed where a number is actually needed, rather than lost to a
 * double here.
 */

import { z } from 'zod';
import type { components } from '../generated/api.js';

export const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  versionRetentionDays: z.union([z.number(), z.string()]),
  storageQuotaBytes: z.union([z.number(), z.string()]),
  createdAt: z.string(),
});

export type Workspace = z.infer<typeof workspaceSchema>;

const _workspaceContract = workspaceSchema satisfies z.ZodType<components['schemas']['WorkspaceResponse']>;
void _workspaceContract;
