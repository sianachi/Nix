/** The backups resource: recent nightly backup results, for the deployment's operators. */

import { defineQuery, type QueryEndpoint } from '../endpoints.js';
import { backupRunListSchema, type BackupRunList } from '../schemas/backups.js';

/** Newest first. Core answers 403 `admin.operator_required` to anyone not listed as an operator. */
export const listBackupRuns = (): QueryEndpoint<BackupRunList> =>
  defineQuery({
    operation: 'admin.backups.list',
    path: '/api/v1/admin/backups?limit=40',
    schema: backupRunListSchema,
    cacheKey: ['admin', 'backups'],
    staleAfterMs: 0,
  });
