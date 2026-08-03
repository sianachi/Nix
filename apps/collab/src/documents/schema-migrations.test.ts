import {
  FIXTURE_DOCUMENT,
  SCHEMA_VERSION,
  VERSION_1_DOCUMENT,
  nixSchema,
} from '@nix/editor-schema';
import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';

import type { ContentDocRow } from '../db/documents.ts';
import type { ScopedQuery } from '../db/tenant-scope.ts';
import type { BodyKindStrategy, Measurement } from './body-kinds.ts';
import { noteStrategy } from './body-kinds.ts';
import {
  MigrationTally,
  SCHEMA_MIGRATIONS,
  migrateDocument,
  stepsFrom,
  type SchemaMigration,
} from './schema-migrations.ts';
import { judgeCandidate } from './session.ts';
import { checkMergedDocument } from './service.ts';

/**
 * The pin, and what keeps it honest.
 *
 * `content_doc.schema_version` is a promise made to every client: no build older than this is
 * needed to open me. These tests are about the two halves of keeping it - refusing a write
 * that would break the promise, and raising the pin only once the document is known to open.
 */

/** A strategy that reports whatever measurement the test wants, so the pin path is reachable. */
function strategyReporting(measurement: Measurement | null): BodyKindStrategy {
  return {
    kind: 'test',
    ceilings: { nodes: 1_000, bytes: 1_000_000 },
    measure: () => measurement,
    materialize: () => ({ json: null, plaintext: '' }),
  };
}

function docRow(overrides: Partial<ContentDocRow> = {}): ContentDocRow {
  return {
    doc_id: 'd0000000-0000-4000-8000-000000000001',
    item_id: 'i0000000-0000-4000-8000-000000000001',
    workspace_id: 'w0000000-0000-4000-8000-000000000001',
    schema_version: 1,
    head_seq: '0',
    ...overrides,
  };
}

/** A query that records what it was asked and returns nothing. */
function recordingQuery(): ScopedQuery & { readonly statements: string[] } {
  const statements: string[] = [];
  return {
    statements,
    query: (text: string) => {
      statements.push(text);
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
}

describe('refusing a write above the document pin', () => {
  const aboveThePin: Measurement = { nodes: 3, bytes: 40, schemaVersion: 2 };

  it('refuses on the HTTP path, naming the version and the pin', () => {
    const refusal = checkMergedDocument(new Y.Doc(), {
      strategy: strategyReporting(aboveThePin),
      pin: 1,
    });

    expect(refusal?.code).toBe('document_above_schema_pin');
    expect(refusal?.status).toBe(409);
    expect(refusal?.detail).toContain('version 2');
    expect(refusal?.detail).toContain('pinned to 1');
  });

  it('allows the same document once the pin has been raised to meet it', () => {
    expect(
      checkMergedDocument(new Y.Doc(), { strategy: strategyReporting(aboveThePin), pin: 2 }),
    ).toBeNull();
  });

  it('allows a document that needs less than its pin', () => {
    // The normal state of every document between a bump and the migration that follows it.
    const below: Measurement = { nodes: 3, bytes: 40, schemaVersion: 1 };
    expect(
      checkMergedDocument(new Y.Doc(), { strategy: strategyReporting(below), pin: 2 }),
    ).toBeNull();
  });

  it('refuses on the socket path without forcing a resync', () => {
    // No resync, deliberately. The client's local state is one this build would happily keep,
    // so reconciling it against the server would discard a legitimate edit and explain nothing.
    const verdict = judgeCandidate(new Y.Doc(), Y.encodeStateAsUpdate(new Y.Doc()), {
      strategy: strategyReporting(aboveThePin),
      pin: 1,
    });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.refusal.code).toBe('document_above_schema_pin');
    expect(verdict.resync).toBe(false);
  });

  it('defaults both paths to this build version, for a document with no stored row', () => {
    const atBuild: Measurement = { nodes: 1, bytes: 10, schemaVersion: SCHEMA_VERSION };
    expect(checkMergedDocument(new Y.Doc(), { strategy: strategyReporting(atBuild) })).toBeNull();
  });

  it('still refuses a document that does not parse at all, before asking about versions', () => {
    const refusal = checkMergedDocument(new Y.Doc(), { strategy: strategyReporting(null), pin: 1 });
    expect(refusal?.code).toBe('document_does_not_parse');
  });
});

describe('the migration step list', () => {
  it('is append-only and contiguous, each step raising the pin by exactly one', () => {
    for (const [index, step] of SCHEMA_MIGRATIONS.entries()) {
      expect(step.to).toBe(step.from + 1);
      expect(step.from).toBe(index + 1);
    }
  });

  it('reaches the version this build speaks', () => {
    // A build whose SCHEMA_VERSION is 3 with steps only up to 2 can never migrate anything
    // past 2, so every older document stays read-only forever with nothing saying why.
    const highest = SCHEMA_MIGRATIONS.reduce((top, step) => Math.max(top, step.to), 1);
    expect(highest).toBe(SCHEMA_VERSION);
  });

  it('selects nothing for a document already at the target', () => {
    expect(stepsFrom(SCHEMA_VERSION, SCHEMA_VERSION)).toHaveLength(0);
  });

  it('chains the steps that carry a document from its pin to the target', () => {
    const steps: SchemaMigration[] = [
      { from: 1, to: 2, describe: 'first' },
      { from: 2, to: 3, describe: 'second' },
      { from: 3, to: 4, describe: 'third' },
    ];

    expect(stepsFrom(2, 4, steps).map((step) => step.describe)).toEqual(['second', 'third']);
  });

  it('refuses a list with a gap rather than skipping the missing step', () => {
    // The one way this mechanism could quietly corrupt a corpus: selecting 2 -> 3 alone for a
    // document pinned at 1 would raise it to 3 without whatever 1 -> 2 was for.
    const steps: SchemaMigration[] = [{ from: 2, to: 3, describe: 'second' }];

    expect(() => stepsFrom(1, 3, steps)).toThrow(/gap/);
  });

  it('refuses a list that stops short of the target', () => {
    const steps: SchemaMigration[] = [{ from: 1, to: 2, describe: 'first' }];

    expect(() => stepsFrom(1, 3, steps)).toThrow(/stops at version 2/);
  });
});

describe('migrating one document', () => {
  it('reports a document already at the target as current, and writes nothing', async () => {
    const sql = recordingQuery();
    const outcome = await migrateDocument(
      sql,
      't0000000-0000-4000-8000-000000000001',
      docRow({ schema_version: SCHEMA_VERSION }),
      'note',
      SCHEMA_VERSION,
    );

    expect(outcome.status).toBe('current');
    expect(sql.statements).toHaveLength(0);
  });

  it('reports a document pinned above this build as ahead, and writes nothing', async () => {
    const sql = recordingQuery();
    const outcome = await migrateDocument(
      sql,
      't0000000-0000-4000-8000-000000000001',
      docRow({ schema_version: SCHEMA_VERSION + 1 }),
      'note',
      SCHEMA_VERSION,
    );

    expect(outcome.status).toBe('ahead');
    expect(sql.statements).toHaveLength(0);
  });
});

describe('a step that declares a content rewrite', () => {
  it('is refused at selection rather than run with its output discarded', () => {
    // The runner cannot yet append a rewrite's delta to the log. Running the hook anyway would
    // transform nothing, raise every pin, and report success - so it fails loudly instead.
    const steps: SchemaMigration[] = [
      { from: 1, to: 2, describe: 'moves content', rewrite: () => undefined },
    ];

    expect(() => stepsFrom(1, 2, steps)).toThrow(/cannot yet append/);
  });
});

describe('the run tally', () => {
  it('counts each outcome and names only the documents that do not open', () => {
    const tally = new MigrationTally();
    for (const outcome of [
      { status: 'migrated', docId: 'a', from: 1, to: 2 },
      { status: 'migrated', docId: 'b', from: 1, to: 2 },
      { status: 'current', docId: 'c' },
      { status: 'ahead', docId: 'd', pin: 9 },
      { status: 'unchanged', docId: 'e' },
      { status: 'aboveTarget', docId: 'f', needs: 3, target: 2 },
      { status: 'unparseable', docId: 'g', pin: 1 },
    ] as const) {
      tally.add(outcome);
    }

    // `aboveTarget` is deliberately not in `unparseable`: the job's exit code is wired to that
    // list, and a healthy document needing a newer build is not a reason to fail a deploy or
    // to send somebody hunting a corruption incident.
    expect(tally.report()).toEqual({
      migrated: 2,
      current: 1,
      ahead: 1,
      unchanged: 1,
      aboveTarget: 1,
      unparseable: ['g'],
    });
  });
});

describe('the note strategy measurement', () => {
  it('reports the version an ordinary document needs alongside its size', () => {
    const state = new Y.Doc();
    prosemirrorJSONToYXmlFragment(nixSchema, VERSION_1_DOCUMENT, state.getXmlFragment('default'));

    const measured = noteStrategy.measure(state);
    expect(measured).not.toBeNull();
    expect(measured?.nodes).toBeGreaterThan(0);
    // The whole point of the seam: nothing in the original node set requires a newer build,
    // so every document written before the first bump migrates on a pin change alone.
    expect(measured?.schemaVersion).toBe(1);
  });

  it('reports version 2 for a document using what version 2 added', () => {
    const state = new Y.Doc();
    prosemirrorJSONToYXmlFragment(nixSchema, FIXTURE_DOCUMENT, state.getXmlFragment('default'));

    // And this is what the pin check reads. A document like this one cannot be written into a
    // document still pinned at 1 until the migration has raised it.
    expect(noteStrategy.measure(state)?.schemaVersion).toBe(SCHEMA_VERSION);
  });
});

describe('why a document would not parse', () => {
  /** A fragment holding an element the schema has never heard of. */
  function unknownNode(): Y.Doc {
    const state = new Y.Doc();
    state.getXmlFragment('default').insert(0, [new Y.XmlElement('nodeThisBuildHasNeverHeardOf')]);
    return state;
  }

  it('names the parser error rather than swallowing it', () => {
    // `document_does_not_parse` was a black box: the refusal a client sees is deliberately vague,
    // and the operator log inherited that vagueness - so a document that silently would not save
    // gave nobody anything to work from. The parser knows exactly what failed.
    expect(noteStrategy.explain?.(unknownNode())).toContain('Invalid content for node doc');
  });

  it('tells the two shapes of this failure apart', () => {
    // Both arrive as the same parser message, because an unknown node is *dropped* rather than
    // refused - so a fragment full of them converts to an empty document and reads identically to
    // a fragment that was empty all along. The shape is what separates "the client sent nothing"
    // from "the client sent something this build does not know", and those want opposite fixes.
    expect(noteStrategy.explain?.(unknownNode())).toContain(
      'fragment held: nodeThisBuildHasNeverHeardOf',
    );
    expect(noteStrategy.explain?.(new Y.Doc())).toContain('dropped as unknown');
  });

  it('admits it cannot tell, once the document has been parsed out from under it', () => {
    // Reading a fragment as prose drops the nodes the schema does not know, from the Yjs document
    // itself - so a second look cannot distinguish "was empty" from "was emptied". Saying so is
    // the honest answer; a bare "empty" is the reading that hides what happened. The socket path
    // avoids the question entirely by explaining from a fork nothing has parsed.
    const state = unknownNode();
    noteStrategy.measure(state);

    expect(noteStrategy.explain?.(state)).toContain('dropped as unknown');
  });

  it('says so plainly when the fragment is empty', () => {
    // The commonest shape of this failure, and the one that reads as nothing at all without a
    // word for it: `doc` requires `block+`, and an untouched fragment has no children.
    const reason = noteStrategy.explain?.(new Y.Doc());

    expect(reason).toBeTruthy();
    expect(reason).toContain('empty');
  });

  it('says nothing about a document that parses', () => {
    const state = new Y.Doc();
    prosemirrorJSONToYXmlFragment(nixSchema, VERSION_1_DOCUMENT, state.getXmlFragment('default'));

    expect(noteStrategy.explain?.(state)).toBeNull();
  });

  it('reaches the log through a refused candidate', () => {
    // The whole point: the seam has to actually connect, or the explanation is written and read by
    // nobody. Asserted through `judgeCandidate`, which is the path a socket update takes.
    const reasons: string[] = [];
    const resident = new Y.Doc();

    judgeCandidate(resident, Y.encodeStateAsUpdate(unknownNode()), {
      strategy: noteStrategy,
      diagnose: (reason) => reasons.push(reason),
    });

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('fragment held: nodeThisBuildHasNeverHeardOf');
  });
});
