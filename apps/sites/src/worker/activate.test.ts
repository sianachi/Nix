import { describe, expect, it } from 'vitest';

import { TransferError, type ObjectTransfer } from '../shared/object-transfer.ts';
import { activateSite } from './activate.ts';
import type { ActivationOp, CoreClient } from './core-client.ts';
import type { JobContext } from './dispatch.ts';

const SITE = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';

function deleteOp(hostname: string): ActivationOp {
  return {
    op: 'delete',
    hostname,
    key: `sites/_hosts/${hostname}.json`,
    body: null,
    url: `delete:${hostname}`,
    expiresAt: '2026-10-11T00:05:00Z',
    readUrl: `read:${hostname}`,
  };
}

async function run(stored: Record<string, string | undefined>): Promise<string[]> {
  const deleted: string[] = [];
  let applied = false;
  const core = {
    activation: () =>
      Promise.resolve({
        activationId: 'a',
        reason: 'hostnames',
        siteId: SITE,
        ops: Object.keys(stored).map(deleteOp),
      }),
    applied: () => {
      applied = true;
      return Promise.resolve();
    },
  } as unknown as CoreClient;
  const objects = {
    download: (url: string) => {
      const body = stored[url.slice('read:'.length)];
      return body === undefined
        ? Promise.reject(new TransferError('missing', 404))
        : Promise.resolve(Buffer.from(body));
    },
    delete: (url: string) => {
      deleted.push(url.slice('delete:'.length));
      return Promise.resolve();
    },
  } as unknown as ObjectTransfer;
  const context = {
    execution: { jobId: 'j', executionId: 'w:e' },
    signal: new AbortController().signal,
  } as unknown as JobContext;

  await activateSite({ core, objects }, context);
  expect(applied).toBe(true);
  return deleted;
}

describe('a site.activate delete', () => {
  it('removes only manifests that still name this site', async () => {
    const deleted = await run({
      'mine.example.com': JSON.stringify({ version: 1, siteId: SITE }),
      'taken.example.com': JSON.stringify({ version: 1, siteId: OTHER }),
      'gone.example.com': undefined,
      'garbled.example.com': 'not json',
    });

    expect(deleted).toEqual(['mine.example.com']);
  });
});
