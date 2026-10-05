import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import type { CoreTemplateImportClient, TemplateImportBodyAuthorizationItem } from './core.ts';
import { createTemplateImportBodyService } from './bodies.ts';

const IMPORT = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const PRINCIPAL = '33333333-3333-4333-8333-333333333333';
const WORKSPACE = '44444444-4444-4444-8444-444444444444';
const CORE_TARGET = '55555555-5555-4555-8555-555555555555';
const REQUEST_TARGET = '66666666-6666-4666-8666-666666666666';
const FILE_TARGET = '99999999-9999-4999-8999-999999999999';
const EXECUTION = {
  importId: IMPORT,
  jobId: '77777777-7777-4777-8777-777777777777',
  executionId: 'worker:lease',
} as const;
const BODY = {
  schemaVersion: 2,
  prosemirror: { type: 'doc', content: [{ type: 'paragraph' }] },
} as const;

describe('worker-fenced template import body materialization', () => {
  it('rejects a missing required write before opening a database connection', async () => {
    let connected = false;
    const service = createTemplateImportBodyService({
      pool: refusingPool(() => {
        connected = true;
      }),
      core: fakeCore([
        { sourceId: 'root', targetItemId: CORE_TARGET, itemType: 'note', bodyRequired: true },
      ]),
    });

    await expect(service.write({ ...EXECUTION, body: { writes: [] } })).rejects.toMatchObject({
      status: 422,
      code: 'template.import_body_invalid',
    });
    expect(connected).toBe(false);
  });

  it('rejects duplicate source writes before asking Core or opening a database connection', async () => {
    let connected = false;
    let authorized = false;
    const service = createTemplateImportBodyService({
      pool: refusingPool(() => {
        connected = true;
      }),
      core: {
        authorizeBodies: () => {
          authorized = true;
          throw new Error('Core should not be reached for malformed input.');
        },
      },
    });

    await expect(
      service.write({
        ...EXECUTION,
        body: {
          writes: [
            { sourceId: 'root', body: BODY },
            { sourceId: 'root', body: BODY },
          ],
        },
      }),
    ).rejects.toMatchObject({ status: 422, code: 'template.import_body_invalid' });
    expect(authorized).toBe(false);
    expect(connected).toBe(false);
  });

  it('derives every persisted and returned target identifier only from Core', async () => {
    const queryValues: unknown[][] = [];
    const service = createTemplateImportBodyService({
      pool: recordingPool(queryValues),
      core: fakeCore([
        { sourceId: 'root', targetItemId: CORE_TARGET, itemType: 'note', bodyRequired: true },
      ]),
    });

    const result = await service.write({
      ...EXECUTION,
      body: {
        writes: [
          {
            sourceId: 'root',
            targetItemId: REQUEST_TARGET,
            body: BODY,
          },
        ],
      },
    });

    expect(result).toEqual({ writtenTargetItemIds: [CORE_TARGET] });
    const scalarValues = flattenValues(queryValues);
    expect(scalarValues).toContain(CORE_TARGET);
    expect(scalarValues).not.toContain(REQUEST_TARGET);
  });

  it('uses bodyless item mappings when rewriting references inside editable bodies', async () => {
    const queryValues: unknown[][] = [];
    const service = createTemplateImportBodyService({
      pool: recordingPool(queryValues),
      core: fakeCore([
        { sourceId: 'root', targetItemId: CORE_TARGET, itemType: 'note', bodyRequired: true },
        { sourceId: 'file', targetItemId: FILE_TARGET, itemType: 'file', bodyRequired: false },
      ]),
    });

    await service.write({
      ...EXECUTION,
      body: {
        writes: [
          {
            sourceId: 'root',
            body: {
              schemaVersion: 2,
              prosemirror: {
                type: 'doc',
                content: [
                  {
                    type: 'paragraph',
                    content: [
                      {
                        type: 'reference',
                        attrs: { kind: 'item', targetId: 'file', label: 'Attachment' },
                      },
                    ],
                  },
                ],
              },
            },
          },
        ],
      },
    });

    const persisted = JSON.stringify(queryValues);
    expect(persisted).toContain(FILE_TARGET);
    expect(persisted).not.toContain('"targetId":"file"');
  });

  it('rolls back before writing when the database transaction cannot fence the worker lease', async () => {
    const queries: string[] = [];
    const service = createTemplateImportBodyService({
      pool: recordingPool([], false, queries),
      core: fakeCore([
        { sourceId: 'root', targetItemId: CORE_TARGET, itemType: 'note', bodyRequired: true },
      ]),
    });

    await expect(
      service.write({ ...EXECUTION, body: { writes: [{ sourceId: 'root', body: BODY }] } }),
    ).rejects.toMatchObject({ status: 409, code: 'template.execution_lost' });
    expect(queries.some((query) => query.includes('nix_fence_worker_execution'))).toBe(true);
    expect(queries.some((query) => query.includes('INSERT INTO content_doc'))).toBe(false);
    expect(queries).toContain('ROLLBACK');
  });
});

function fakeCore(items: readonly TemplateImportBodyAuthorizationItem[]): CoreTemplateImportClient {
  return {
    authorizeBodies: () =>
      Promise.resolve({
        tenantId: TENANT,
        principalId: PRINCIPAL,
        workspaceId: WORKSPACE,
        importId: IMPORT,
        operationId: '88888888-8888-4888-8888-888888888888',
        items,
        canWrite: true,
      }),
  };
}

function refusingPool(onConnect: () => void): Pool {
  return {
    connect: () => {
      onConnect();
      throw new Error('database should not be reached');
    },
  } as unknown as Pool;
}

function recordingPool(
  queryValues: unknown[][],
  fenceAuthorized = true,
  queries: string[] = [],
): Pool {
  const client = {
    query: (text: string, values: unknown[] = []) => {
      queries.push(text);
      queryValues.push(values);
      const rows = text.includes('nix_fence_worker_execution')
        ? [{ authorized: fenceAuthorized }]
        : text.includes('RETURNING item_id')
          ? ((values[4] ?? []) as string[]).map((item_id) => ({ item_id }))
          : [];
      return Promise.resolve({ rows, rowCount: rows.length });
    },
    release: () => undefined,
  };
  return { connect: () => Promise.resolve(client) } as unknown as Pool;
}

function flattenValues(groups: readonly (readonly unknown[])[]): readonly unknown[] {
  const flattened: unknown[] = [];
  for (const values of groups) {
    for (const value of values) {
      if (Array.isArray(value)) {
        for (const nested of value as unknown[]) flattened.push(nested);
      } else {
        flattened.push(value);
      }
    }
  }
  return flattened;
}
