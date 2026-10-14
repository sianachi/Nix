import { describe, expect, it } from 'vitest';

import { backupRunSchema } from './backups.js';
import { currentPrincipalSchema } from './current-principal.js';

const run = {
  id: '0b0b0b0b-1111-4111-8111-0b0b0b0b0b0b',
  startedAt: '2026-10-14T01:00:00+00:00',
  finishedAt: '2026-10-14T01:05:00Z',
  step: 'local',
  status: 'succeeded',
  snapshotId: null,
  bytes: '2048',
  error: null,
};

describe('backup run schema', () => {
  it('reads an int64 sent as a digit string as a number', () => {
    expect(backupRunSchema.parse(run).bytes).toBe(2048);
    expect(backupRunSchema.parse({ ...run, bytes: null }).bytes).toBeNull();
  });

  it('refuses an unknown step or status', () => {
    expect(backupRunSchema.safeParse({ ...run, step: 'tape' }).success).toBe(false);
    expect(backupRunSchema.safeParse({ ...run, status: 'skipped' }).success).toBe(false);
  });
});

describe('current principal features', () => {
  it('defaults operator to false for an older Core', () => {
    const principal = currentPrincipalSchema.parse({
      id: '0b0b0b0b-1111-4111-8111-0b0b0b0b0b0b',
      tenantId: '0c0c0c0c-1111-4111-8111-0c0c0c0c0c0c',
      displayName: 'A',
      email: null,
      isTenantAdministrator: false,
      features: { sites: true, mcpUrl: null },
    });
    expect(principal.features.operator).toBe(false);
  });
});
