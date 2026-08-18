import { describe, expect, it } from 'vitest';
import { nixSchema, FIXTURE_DOCUMENT } from '@nix/editor-schema';
import { documentToMarkdown } from './to-markdown.js';
import { markdownToDocument } from './from-markdown.js';
import { MARKDOWN_LOSSES } from './losses.js';

/** A document wrapper around one or more block nodes. */
function doc(...content: unknown[]): unknown {
  return { type: 'doc', content };
}

function paragraph(...content: unknown[]): unknown {
  return { type: 'paragraph', content };
}

function text(value: string, marks?: { type: string; attrs?: Record<string, unknown> }[]): unknown {
  return marks === undefined ? { type: 'text', text: value } : { type: 'text', text: value, marks };
}

/** Canonicalise a document through the schema, so a comparison is over meaning, not over which
 *  default attributes each side happened to spell out. */
function canonical(json: unknown): unknown {
  return nixSchema.nodeFromJSON(json).toJSON();
}

/** Round-trip a document body through Markdown and back, returning the parsed result. */
function roundTrip(body: unknown): ReturnType<typeof markdownToDocument> {
  return markdownToDocument(documentToMarkdown(body).markdown);
}

describe('documentToMarkdown then markdownToDocument', () => {
  it('round-trips the schema fixture document into a valid body', () => {
    const result = roundTrip(FIXTURE_DOCUMENT);
    expect(result.ok).toBe(true);
  });

  it.each([
    ['a heading', doc({ type: 'heading', attrs: { level: 2 }, content: [text('A heading')] })],
    ['a paragraph', doc(paragraph(text('Plain prose.')))],
    ['a blockquote', doc({ type: 'blockquote', content: [paragraph(text('Quoted.'))] })],
    ['a horizontal rule', doc(paragraph(text('Above.')), { type: 'horizontalRule' }, paragraph(text('Below.')))],
    [
      'a fenced code block',
      doc({ type: 'codeBlock', attrs: { language: 'typescript' }, content: [text('const answer = 42;')] }),
    ],
    [
      'a bullet list',
      doc({
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [paragraph(text('One'))] },
          { type: 'listItem', content: [paragraph(text('Two'))] },
        ],
      }),
    ],
    ['an image', doc({ type: 'image', attrs: { src: 'https://example.test/d.png', alt: 'A diagram' } })],
  ])('round-trips %s unchanged', (_label, body) => {
    const result = roundTrip(body);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(canonical(result.doc)).toEqual(canonical(body));
    }
  });

  it('round-trips the inline marks Markdown carries', () => {
    const body = doc(
      paragraph(
        text('bold', [{ type: 'bold' }]),
        text(' '),
        text('italic', [{ type: 'italic' }]),
        text(' '),
        text('struck', [{ type: 'strike' }]),
        text(' '),
        text('code', [{ type: 'code' }]),
      ),
    );
    const result = roundTrip(body);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(canonical(result.doc)).toEqual(canonical(body));
    }
  });

  it('round-trips a callout through its admonition spelling', () => {
    const body = doc({
      type: 'callout',
      attrs: { tone: 'warning' },
      content: [paragraph(text('Mind the gap.'))],
    });
    const result = roundTrip(body);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(canonical(result.doc)).toEqual(canonical(body));
    }
  });

  it('round-trips a reference through its nix link', () => {
    const body = doc(
      paragraph(
        text('See '),
        {
          type: 'reference',
          attrs: { kind: 'item', targetId: '0199c0de-0000-7000-8000-000000000001', label: 'The other note' },
        },
      ),
    );
    const result = roundTrip(body);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(canonical(result.doc)).toEqual(canonical(body));
    }
  });
});

describe('documentToMarkdown emits the documented spellings', () => {
  it('writes a callout as a tone admonition blockquote', () => {
    const { markdown } = documentToMarkdown(
      doc({ type: 'callout', attrs: { tone: 'warning' }, content: [paragraph(text('Careful.'))] }),
    );
    expect(markdown).toContain('> [!warning]');
    expect(markdown).toContain('Careful.');
  });

  it('writes a reference as a nix item link', () => {
    const { markdown } = documentToMarkdown(
      doc(
        paragraph({
          type: 'reference',
          attrs: { kind: 'item', targetId: 'abc', label: 'Note' },
        }),
      ),
    );
    expect(markdown).toContain('[Note](nix://item/abc)');
  });

  it('writes a details block as HTML', () => {
    const { markdown } = documentToMarkdown(
      doc({
        type: 'details',
        attrs: { toggleLevel: 2 },
        content: [
          { type: 'detailsSummary', content: [text('Show the details')] },
          { type: 'detailsContent', content: [paragraph(text('Here they are.'))] },
        ],
      }),
    );
    expect(markdown).toContain('<details');
    expect(markdown).toContain('<summary>Show the details</summary>');
  });
});

describe('declared losses', () => {
  it('reports a flattened column layout and keeps the text', () => {
    const body = doc({
      type: 'columnBlock',
      content: [
        { type: 'column', attrs: { width: 2 }, content: [paragraph(text('Left.'))] },
        { type: 'column', attrs: { width: null }, content: [paragraph(text('Right.'))] },
      ],
    });
    const { markdown, losses } = documentToMarkdown(body);
    expect(losses.map((loss) => loss.kind)).toContain(MARKDOWN_LOSSES.columnsFlattened.kind);
    expect(markdown).toContain('Left.');
    expect(markdown).toContain('Right.');
    // The flattened form still parses into a valid body, it is simply no longer two columns.
    expect(roundTrip(body).ok).toBe(true);
  });

  it('degrades a details block to readable content that still validates', () => {
    const body = doc({
      type: 'details',
      attrs: { toggleLevel: null },
      content: [
        { type: 'detailsSummary', content: [text('Summary')] },
        { type: 'detailsContent', content: [paragraph(text('Body text.'))] },
      ],
    });
    const result = roundTrip(body);
    expect(result.ok).toBe(true);
    expect(documentToMarkdown(result.ok ? result.doc : body).markdown).toContain('Body text.');
  });
});

describe('markdownToDocument', () => {
  it('parses standard Markdown into a valid body', () => {
    const result = markdownToDocument('# Title\n\nA paragraph with **bold** and a [link](https://x.test).');
    expect(result.ok).toBe(true);
  });
});
