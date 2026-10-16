/** Tenant administrators: who holds the tenant admin role, and granting or removing it. */

import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import { noContentSchema } from '../schemas/index.js';
import type { CursorPage } from '../schemas/pagination.js';
import { tenantRoleGrantPageSchema, type TenantRoleGrant } from '../schemas/tenant-roles.js';

const rolesKey = ['tenant', 'roles'] as const;

/** One page holds every administrator. Callers who are not administrators get an empty page. */
export const listTenantRoles = (): QueryEndpoint<CursorPage<TenantRoleGrant>> =>
  defineQuery({
    operation: 'tenant.roles.list',
    path: '/api/v1/tenant/roles',
    schema: tenantRoleGrantPageSchema,
    cacheKey: rolesKey,
    staleAfterMs: 0,
  });

export const grantTenantAdmin = (principalId: string): CommandEndpoint<undefined> =>
  defineCommand({
    operation: 'tenant.admins.grant',
    method: 'PUT',
    path: `/api/v1/tenant/admins/${principalId}`,
    schema: noContentSchema,
    invalidates: [rolesKey],
  });

/** Refused with 409 `roles.last_administrator` when it would leave no administrator. */
export const revokeTenantAdmin = (principalId: string): CommandEndpoint<undefined> =>
  defineCommand({
    operation: 'tenant.admins.revoke',
    method: 'DELETE',
    path: `/api/v1/tenant/admins/${principalId}`,
    schema: noContentSchema,
    invalidates: [rolesKey],
  });
