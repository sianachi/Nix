/** The signed-in caller, as `GET /api/v1/me` returns it. */

import { z } from 'zod';
import type { CurrentPrincipalContract } from '../contracts.js';

export const currentPrincipalSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  displayName: z.string(),
  email: z.string().nullable(),
  isTenantAdministrator: z.boolean(),
});

export type CurrentPrincipal = z.infer<typeof currentPrincipalSchema>;

const _currentPrincipalContract =
  currentPrincipalSchema satisfies z.ZodType<CurrentPrincipalContract>;
void _currentPrincipalContract;
