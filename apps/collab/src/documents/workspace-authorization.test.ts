import { SCHEMA_VERSION } from '@nix/editor-schema';
import { describe, expect, it } from 'vitest';

import type { ScopedQuery } from '../db/tenant-scope.ts';
import { openDocument } from './service.ts';

const SOURCE = '44444444-4444-4444-8444-444444444444';
const DESTINATION = '99999999-9999-4999-8999-999999999999';

function database(existing: boolean, workspaceId: string): ScopedQuery {
  let created = existing;
  return {
    query: (text: string) => {
      if (text.includes('INSERT INTO content_doc')) created = true;
      const rows =
        text.includes('FROM content_doc') && created
          ? [
              {
                doc_id: 'doc',
                item_id: 'item',
                workspace_id: workspaceId,
                schema_version: SCHEMA_VERSION,
                head_seq: '0',
              },
            ]
          : [];
      return Promise.resolve({ rows, rowCount: rows.length });
    },
  } as unknown as ScopedQuery;
}

describe('document containment after authorization', () => {
  it('refuses an existing body moved after Core answered', async () => {
    expect(
      await openDocument(database(true, DESTINATION), 'tenant', 'item', SOURCE, () => 'doc'),
    ).toBeNull();
  });

  it('refuses a first-open body rebound by a transfer while creation waited', async () => {
    expect(
      await openDocument(database(false, DESTINATION), 'tenant', 'item', SOURCE, () => 'doc'),
    ).toBeNull();
  });

  it('opens with a new authorization for the destination workspace', async () => {
    expect(
      await openDocument(database(true, DESTINATION), 'tenant', 'item', DESTINATION, () => 'doc'),
    ).toMatchObject({ workspace_id: DESTINATION });
  });
});
