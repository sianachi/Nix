import { readFileSync } from 'node:fs';

import { nixSchema } from '@nix/editor-schema';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Pool } from 'pg';
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { createTranscriptionAppendService } from './append.ts';
import { createCoreTranscriptionClient } from './core.ts';

/**
 * The speech contract, proved against the fixtures the Go worker and Core assert on too.
 *
 * The files live with the worker (`apps/go-workers/internal/workerapi/testdata/speech/`) and are
 * read from disk, never copied here: a copy would keep passing after the other side changed. `t3`
 * is exactly what Core answers the authorization request with; `t4` is exactly the body the
 * worker posts to the append route. Both go through the production parser and validation
 * verbatim, and the section they produce is checked for the one thing a third party depends on -
 * the timestamp address the web app parses to seek the recording.
 */
const FIXTURES = new URL(
  '../../../go-workers/internal/workerapi/testdata/speech/',
  import.meta.url,
);

function fixtureText(name: string): string {
  return readFileSync(new URL(name, FIXTURES), 'utf8');
}

const AUTHORIZATION = {
  tenantId: 'aaaaaaaa-0000-4000-8000-000000000001',
  principalId: 'bbbbbbbb-0000-4000-8000-000000000002',
  workspaceId: 'eeeeeeee-0000-4000-8000-000000000005',
  noteItemId: 'dddddddd-0000-4000-8000-000000000004',
  audioItemId: 'cccccccc-0000-4000-8000-000000000003',
  audioTitle: 'Meeting 2026-10-05 14.30.weba',
  canWrite: true,
};

const JOB = '99999999-0000-4000-8000-000000000009';
const DOC = '88888888-0000-4000-8000-000000000008';

/** The Core client, answered with the fixture's bytes exactly as they are on disk. */
function coreAnsweringFixture() {
  return createCoreTranscriptionClient({
    coreBaseUrl: 'https://core.test',
    internalSecret: 'service-secret',
    fetchImpl: () =>
      Promise.resolve(
        new Response(fixtureText('t3_authorization_response.json'), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
  });
}

/**
 * A database holding one fenced job and a note with no body yet, recording what is appended.
 * Just enough for the service to run end to end; the merge itself is the Postgres suite's.
 */
function emptyNotePool(written: Uint8Array[]): Pool {
  let created = false;
  let head = 0;
  const client = {
    query: (text: string, values: readonly unknown[] = []) => {
      let rows: unknown[] = [];
      if (text.includes('nix_fence_worker_execution')) {
        rows = [{ authorized: true }];
      } else if (text.includes('INSERT INTO content_doc')) {
        created = true;
      } else if (text.includes('FROM content_doc')) {
        rows = created
          ? [
              {
                doc_id: DOC,
                item_id: AUTHORIZATION.noteItemId,
                workspace_id: AUTHORIZATION.workspaceId,
                schema_version: 4,
                head_seq: String(head),
              },
            ]
          : [];
      } else if (text.includes('UPDATE content_doc')) {
        head += 1;
        rows = [{ head_seq: String(head) }];
      } else if (text.includes('INSERT INTO content_update')) {
        written.push(new Uint8Array(values[3] as Buffer));
      }
      return Promise.resolve({ rows, rowCount: rows.length });
    },
    release: () => undefined,
  };
  return { connect: () => Promise.resolve(client) } as unknown as Pool;
}

describe('the speech contract fixtures', () => {
  it('t3: the Core client accepts the authorization response verbatim', async () => {
    await expect(
      coreAnsweringFixture().authorize({ jobId: JOB, executionId: 'worker:lease' }),
    ).resolves.toEqual(AUTHORIZATION);
  });

  it('t4: the append accepts the worker request verbatim and builds the section the web app reads', async () => {
    const written: Uint8Array[] = [];
    const service = createTranscriptionAppendService({
      pool: emptyNotePool(written),
      core: coreAnsweringFixture(),
      newDocId: () => DOC,
    });

    // Parsed the way Fastify hands it to the route: JSON, nothing else done to it.
    const body: unknown = JSON.parse(fixtureText('t4_append_request.json'));
    await expect(
      service.append({ jobId: JOB, executionId: 'worker:lease', body }),
    ).resolves.toEqual({ appended: true, paragraphs: 3, noteItemId: AUTHORIZATION.noteItemId });

    expect(written).toHaveLength(1);
    const note = new Y.Doc();
    for (const update of written) {
      Y.applyUpdate(note, update);
    }
    const root = yXmlFragmentToProseMirrorRootNode(note.getXmlFragment('default'), nixSchema);
    root.check();

    const lines: string[] = [];
    root.forEach((node) => {
      lines.push(node.textBetween(0, node.content.size));
    });
    expect(lines).toEqual([
      'Transcript',
      'From Meeting 2026-10-05 14.30.weba, 1:01 long.',
      '[0:00] Me: Shall we start?',
      '[0:04] Others: Yes, go ahead.',
      '[0:30] A line with no speaker.',
    ]);

    // The reference points at the fixture's recording.
    const references: ProseMirrorNode[] = [];
    root.descendants((node) => {
      if (node.type.name === 'reference') references.push(node);
    });
    expect(references.map((node) => node.attrs)).toEqual([
      {
        kind: 'item',
        targetId: AUTHORIZATION.audioItemId,
        label: AUTHORIZATION.audioTitle,
      },
    ]);

    // Speaker labels are bold text of their own, and only where a speaker was named.
    const bold: string[] = [];
    const hrefs: string[] = [];
    root.descendants((node) => {
      if (!node.isText) return;
      if (node.marks.some((mark) => mark.type.name === 'bold')) bold.push(node.text ?? '');
      for (const mark of node.marks) {
        if (mark.type.name === 'link') hrefs.push(String(mark.attrs.href));
      }
    });
    expect(bold).toEqual(['Me:', 'Others:']);

    // Exactly the address the web app intercepts: `/w/<workspace>`, `item=<audio>`, and `t` in
    // whole seconds, digits only - 4200ms and 30500ms round down, never to a fraction.
    const base = `/w/${AUTHORIZATION.workspaceId}?item=${AUTHORIZATION.audioItemId}&t=`;
    expect(hrefs).toEqual([`${base}0`, `${base}4`, `${base}30`]);
    for (const href of hrefs) {
      expect(href).toMatch(/^\/w\/[0-9a-f-]{36}\?item=[0-9a-f-]{36}&t=\d+$/);
      const url = new URL(href, 'https://nix.test');
      expect(url.pathname).toBe(`/w/${AUTHORIZATION.workspaceId}`);
      expect([...url.searchParams.keys()]).toEqual(['item', 't']);
      expect(url.searchParams.get('item')).toBe(AUTHORIZATION.audioItemId);
    }
  });
});
