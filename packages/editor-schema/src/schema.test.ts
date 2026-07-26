import { describe, expect, it } from 'vitest';

import { FIXTURE_DOCUMENT, MARK_FIXTURES, NODE_FIXTURES } from './fixtures.js';
import { SCHEMA_VERSION, countNodes, emptyDocument, nixSchema, parseDocument } from './schema.js';

function documentOf(block: unknown): unknown {
  return { type: 'doc', content: [block] };
}

describe('the node set', () => {
  const expected = [
    'doc',
    'paragraph',
    'text',
    'hardBreak',
    'heading',
    'blockquote',
    'codeBlock',
    'horizontalRule',
    'callout',
    'image',
    'bulletList',
    'orderedList',
    'listItem',
    'taskList',
    'taskItem',
    'table',
    'tableRow',
    'tableHeader',
    'tableCell',
  ];

  it.each(expected)('includes %s', (name) => {
    expect(nixSchema.nodes[name]).toBeDefined();
  });

  it('has no node the fixtures do not cover', () => {
    // The reverse direction, and the one that catches a block added without a fixture -
    // which is a block the collaboration service has never been asked to parse.
    const covered = new Set([
      'doc',
      'text',
      'listItem',
      'taskItem',
      'tableRow',
      'tableHeader',
      'tableCell',
      ...Object.keys(NODE_FIXTURES),
    ]);

    expect(Object.keys(nixSchema.nodes).filter((name) => !covered.has(name))).toEqual([]);
  });
});

describe('the mark set', () => {
  const expected = ['bold', 'italic', 'underline', 'strike', 'code', 'highlight', 'link'];

  it.each(expected)('includes %s', (name) => {
    expect(nixSchema.marks[name]).toBeDefined();
  });

  it('has no mark the fixtures do not cover', () => {
    expect(Object.keys(nixSchema.marks).sort()).toEqual(Object.keys(MARK_FIXTURES).sort());
  });
});

describe('round-tripping', () => {
  it.each(Object.entries(NODE_FIXTURES))(
    '%s survives a parse and a serialise',
    (_name, fixture) => {
      const parsed = parseDocument(documentOf(fixture));

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      // Serialising and reparsing has to reach the same JSON. An attribute the schema
      // silently drops shows up here and nowhere else.
      expect(parsed.document.toJSON()).toEqual(documentOf(fixture));
    },
  );

  it.each(Object.entries(MARK_FIXTURES))(
    '%s survives a parse and a serialise',
    (_name, fixture) => {
      const parsed = parseDocument(documentOf(fixture));

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      expect(parsed.document.toJSON()).toEqual(documentOf(fixture));
    },
  );

  it('parses the document that uses every node and mark', () => {
    const parsed = parseDocument(FIXTURE_DOCUMENT);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.document.toJSON()).toEqual(FIXTURE_DOCUMENT);
  });
});

describe('tables', () => {
  it('keeps a merged cell merged', () => {
    const merged = {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableCell',
              attrs: { colspan: 2, rowspan: 1, colwidth: null, align: null },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Spans two' }] }],
            },
          ],
        },
      ],
    };

    const parsed = parseDocument(documentOf(merged));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.document.toJSON()).toEqual(documentOf(merged));
  });

  it('keeps a column width', () => {
    const sized = {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableCell',
              attrs: { colspan: 1, rowspan: 1, colwidth: [180], align: null },
              content: [{ type: 'paragraph' }],
            },
          ],
        },
      ],
    };

    const parsed = parseDocument(documentOf(sized));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.document.toJSON()).toEqual(documentOf(sized));
  });
});

describe('refusals', () => {
  it('refuses a node the schema does not define', () => {
    const parsed = parseDocument(documentOf({ type: 'spreadsheet' }));

    expect(parsed.ok).toBe(false);
  });

  it('refuses a mark the schema does not define', () => {
    const parsed = parseDocument(
      documentOf({
        type: 'paragraph',
        content: [{ type: 'text', marks: [{ type: 'blink' }], text: 'no' }],
      }),
    );

    expect(parsed.ok).toBe(false);
  });

  it('refuses a block nested where the schema forbids it', () => {
    // A table row directly inside the document, with no table around it.
    const parsed = parseDocument(documentOf({ type: 'tableRow', content: [] }));

    expect(parsed.ok).toBe(false);
  });

  it('refuses something that is not a document at all', () => {
    expect(parseDocument(null).ok).toBe(false);
    expect(parseDocument('a string').ok).toBe(false);
  });
});

describe('callout tones', () => {
  it('accepts a tone this build does not know, and keeps it', () => {
    const parsed = parseDocument(
      documentOf({
        type: 'callout',
        attrs: { tone: 'interstellar' },
        content: [{ type: 'paragraph' }],
      }),
    );

    // Parsed, not refused: a callout whose colour this build cannot pick is readable, and
    // a document that will not open is not.
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // Kept verbatim in the document rather than rewritten. An older build normalising the
    // value on load would destroy a newer build's tone the moment anybody opened the note
    // - a downgrade that silently edits documents is worse than one that renders them
    // plainly.
    expect(parsed.document.firstChild?.attrs.tone).toBe('interstellar');
  });

  it('renders an unknown tone as the default one', () => {
    // Where the fallback actually applies: on the way out. The colour comes from a token
    // named after the tone, and there is no token for a tone this build has never heard of.
    const parsed = parseDocument(
      documentOf({
        type: 'callout',
        attrs: { tone: 'interstellar' },
        content: [{ type: 'paragraph' }],
      }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const callout = parsed.document.firstChild;
    if (callout === null) throw new Error('The fixture has no callout.');

    const rendered = JSON.stringify(nixSchema.nodes.callout?.spec.toDOM?.(callout));

    expect(rendered).toContain('"data-tone":"note"');
    expect(rendered).not.toContain('interstellar');
  });
});

describe('the empty document', () => {
  it('has one paragraph, so an editor has somewhere to put a cursor', () => {
    const document = emptyDocument();

    expect(document.childCount).toBe(1);
    expect(document.firstChild?.type.name).toBe('paragraph');
  });

  it('counts as two nodes', () => {
    expect(countNodes(emptyDocument())).toBe(2);
  });
});

describe('the schema version', () => {
  it('is pinned, because stored documents are validated against it', () => {
    expect(SCHEMA_VERSION).toBe(1);
  });
});
