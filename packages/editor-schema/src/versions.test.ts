import { describe, expect, it } from 'vitest';

import { FIXTURE_DOCUMENT } from './fixtures.js';
import { SCHEMA_VERSION, nixSchema, parseDocument } from './schema.js';
import {
  BASE_SCHEMA_VERSION,
  MARK_MIN_VERSION,
  NODE_MIN_VERSION,
  requiredSchemaVersion,
  type MinimumVersions,
} from './versions.js';

/**
 * What a document needs, as distinct from what this build speaks.
 *
 * These two facts are easy to conflate and the conflation is the bug the version tables exist
 * to prevent: `SCHEMA_VERSION` is a property of the code, `requiredSchemaVersion` is a property
 * of one document, and a stored pin is only honest while the second never exceeds it.
 *
 * **The rule is tested against injected tables, not the shipped ones.** Both shipped tables are
 * empty at version 1, so every assertion written against them would also pass for a function
 * that ignored its argument and returned 1 - which is exactly what it would be doing. The
 * tables are a parameter so the behaviour can be stated now rather than first exercised by the
 * bump that depends on it.
 */
describe('the schema version a document requires', () => {
  const tables: MinimumVersions = { nodes: { blockquote: 2, codeBlock: 4 }, marks: { strike: 3 } };

  function parse(json: unknown) {
    const parsed = parseDocument(json);
    if (!parsed.ok) {
      throw new Error(`The fixture does not parse: ${parsed.error}`);
    }
    return parsed.document;
  }

  it('is the base version for a document using nothing the tables name', () => {
    const document = parse({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'plain' }] }],
    });

    expect(requiredSchemaVersion(document, tables)).toBe(BASE_SCHEMA_VERSION);
  });

  it('takes the version of a node that needs one', () => {
    const document = parse({
      type: 'doc',
      content: [{ type: 'blockquote', content: [{ type: 'paragraph', content: [] }] }],
    });

    expect(requiredSchemaVersion(document, tables)).toBe(2);
  });

  it('takes the highest, not the first or the last, when several nodes need one', () => {
    const document = parse({
      type: 'doc',
      content: [
        { type: 'codeBlock', content: [{ type: 'text', text: 'x' }] },
        { type: 'blockquote', content: [{ type: 'paragraph', content: [] }] },
      ],
    });

    // 4 from the code block, not 2 from the blockquote that comes after it.
    expect(requiredSchemaVersion(document, tables)).toBe(4);
  });

  it('is raised by a mark as readily as by a node', () => {
    // A mark is easy to forget when walking a tree, because it hangs off a node rather than
    // being one - and a document whose only new thing is a mark is a document that would be
    // written into a pin too low for it.
    const document = parse({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', marks: [{ type: 'strike' }], text: 'struck' }],
        },
      ],
    });

    expect(requiredSchemaVersion(document, tables)).toBe(3);
  });

  it('finds a node nested several levels down', () => {
    const document = parse({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [] },
                { type: 'blockquote', content: [{ type: 'paragraph', content: [] }] },
              ],
            },
          ],
        },
      ],
    });

    expect(requiredSchemaVersion(document, tables)).toBe(2);
  });

  it('considers the root node, which descendants never visits', () => {
    const document = parse({
      type: 'doc',
      content: [{ type: 'paragraph', content: [] }],
    });

    expect(requiredSchemaVersion(document, { nodes: { doc: 5 }, marks: {} })).toBe(5);
  });

  it('is the base version for the shipped fixture against the shipped tables', () => {
    // The claim the first migration rests on: nothing written before the bump needs anything
    // newer, so raising a pin is all a version-2 migration has to do.
    expect(requiredSchemaVersion(parse(FIXTURE_DOCUMENT))).toBe(BASE_SCHEMA_VERSION);
  });
});

describe('the shipped minimum-version tables', () => {
  it('claim nothing above what this build speaks', () => {
    // A node given a minimum above SCHEMA_VERSION could be produced by this build and then
    // refused everywhere it tried to store it - a bump somebody started and did not finish.
    for (const table of [NODE_MIN_VERSION, MARK_MIN_VERSION]) {
      for (const [name, minimum] of Object.entries(table)) {
        expect(minimum, `${name} claims a minimum above SCHEMA_VERSION`).toBeLessThanOrEqual(
          SCHEMA_VERSION,
        );
      }
    }
  });

  it('claim nothing at or below the base version, which would be noise', () => {
    for (const table of [NODE_MIN_VERSION, MARK_MIN_VERSION]) {
      for (const [name, minimum] of Object.entries(table)) {
        expect(minimum, `${name} names a minimum it did not need to`).toBeGreaterThan(
          BASE_SCHEMA_VERSION,
        );
      }
    }
  });

  it('name only nodes and marks the schema actually has', () => {
    // A stale entry is harmless at runtime and is a sign the table was edited without the
    // extension list, which is exactly the drift this package exists to prevent.
    for (const name of Object.keys(NODE_MIN_VERSION)) {
      expect(nixSchema.nodes[name], `${name} is not a node in the schema`).toBeDefined();
    }
    for (const name of Object.keys(MARK_MIN_VERSION)) {
      expect(nixSchema.marks[name], `${name} is not a mark in the schema`).toBeDefined();
    }
  });
});
