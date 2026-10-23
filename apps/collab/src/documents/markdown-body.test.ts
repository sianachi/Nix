import { nixSchema } from '@nix/editor-schema';
import { documentToMarkdown } from '@nix/markdown';
import { describe, expect, it } from 'vitest';
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import * as Y from 'yjs';

import { FRAGMENT_NAME } from './body-kinds.ts';
import { MARKDOWN_CHAR_LIMIT, markdownDelta, readMarkdown } from './markdown-body.ts';

function docFrom(prose: unknown): Y.Doc {
  const doc = new Y.Doc();
  prosemirrorJSONToYXmlFragment(nixSchema, prose, doc.getXmlFragment(FRAGMENT_NAME));
  return doc;
}

function proseOf(doc: Y.Doc): unknown {
  return yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment(FRAGMENT_NAME), nixSchema).toJSON();
}

describe('markdownDelta', () => {
  it('replaces a note with Markdown as a document the reader renders back', () => {
    const doc = docFrom({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Old' }] }],
    });

    const written = markdownDelta(doc, '# Title\n\nFresh paragraph.', 'replace');

    expect(written.ok).toBe(true);
    const read = readMarkdown(doc);
    expect(read.empty).toBe(false);
    expect(read.markdown).toContain('Title');
    expect(read.markdown).toContain('Fresh paragraph.');
    expect(documentToMarkdown(proseOf(doc)).markdown).not.toContain('Old');
  });

  it('clears a note when the replacement is empty', () => {
    const doc = docFrom({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Gone' }] }],
    });

    const written = markdownDelta(doc, '', 'replace');

    expect(written.ok).toBe(true);
    const read = readMarkdown(doc);
    expect(read.markdown.trim()).toBe('');
    expect(read.empty).toBe(false);
  });

  it('appends blocks and leaves existing marks in place', () => {
    const doc = docFrom({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Kept', marks: [{ type: 'underline' }] }],
        },
      ],
    });

    const written = markdownDelta(doc, 'Added by the API', 'append');

    expect(written.ok).toBe(true);
    expect(proseOf(doc)).toMatchObject({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Kept', marks: [{ type: 'underline' }] }],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'Added by the API' }] },
      ],
    });
  });

  it('refuses an empty append and a body over the character ceiling', () => {
    const doc = docFrom({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Stay' }] }],
    });

    expect(markdownDelta(doc, '   \n', 'append')).toMatchObject({ ok: false });
    const tooLong = markdownDelta(doc, 'x'.repeat(MARKDOWN_CHAR_LIMIT + 1), 'replace');
    expect(tooLong).toMatchObject({ ok: false, tooLong: true });
    expect(proseOf(doc)).toMatchObject({
      content: [{ content: [{ text: 'Stay' }] }],
    });
  });

  it('reads an untouched fragment as an empty note', () => {
    const doc = new Y.Doc();
    expect(readMarkdown(doc)).toEqual({ markdown: '', losses: [], empty: true });
    doc.destroy();
  });
});
