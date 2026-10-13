/** The signed-in caller, as `GET /api/v1/me` returns it. */

import { z } from 'zod';
import type { CurrentPrincipalContract } from '../contracts.js';

export const currentPrincipalSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  displayName: z.string(),
  email: z.string().nullable(),
  isTenantAdministrator: z.boolean(),
  /** Deployment features the shell may offer; defaulted so an older Core answers without them. */
  features: z
    .object({ sites: z.boolean().default(false), mcpUrl: z.string().nullable().default(null) })
    .default({ sites: false, mcpUrl: null }),
});

export type CurrentPrincipal = z.infer<typeof currentPrincipalSchema>;

const _currentPrincipalContract =
  currentPrincipalSchema satisfies z.ZodType<CurrentPrincipalContract>;
void _currentPrincipalContract;
