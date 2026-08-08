import { describe, expect, it } from 'vitest';

import { SEARCH_TEXT_CEILING, boundSearchText, extractItemLinks } from './links.ts';

const SOURCE = '00000000-0000-4000-8000-000000000001';
const TARGET = '00000000-0000-4000-8000-000000000002';
const OTHER = '00000000-0000-4000-8000-000000000003';

/** A reference node as `materialize` produces it. */
function reference(targetId: unknown, kind: unknown = 'item'): unknown {
  return { type: 'reference', attrs: { kind, targetId, label: 'Whatever it was called' } };
}

/** A document with the given inline content in one paragraph. */
function documentOf(...inline: unknown[]): unknown {
  return { type: 'doc', content: [{ type: 'paragraph', content: inline }] };
}

describe('extracting the links out of a document', () => {
  it('finds a reference to another item', () => {
    const links = extractItemLinks(documentOf(reference(TARGET)), SOURCE);

    expect([...links]).toEqual([[TARGET, 1]]);
  });

  it('counts repeated references to the same item once, with the count', () => {
    // Five mentions of a document is one backlink. A panel that listed the same source five
    // times would be reporting how the sentence was written rather than what points at you.
    const links = extractItemLinks(
      documentOf(reference(TARGET), reference(TARGET), reference(TARGET)),
      SOURCE,
    );

    expect([...links]).toEqual([[TARGET, 3]]);
  });

  it('finds references nested arbitrarily deep', () => {
    // Lists inside quotes inside lists is an ordinary document, not an adversarial one.
    const deep = {
      type: 'doc',
      content: [
        {
          type: 'blockquote',
          content: [
            {
              type: 'bulletList',
              content: [
                {
                  type: 'listItem',
                  content: [{ type: 'paragraph', content: [reference(TARGET)] }],
                },
              ],
            },
          ],
        },
      ],
    };

    expect([...extractItemLinks(deep, SOURCE)]).toEqual([[TARGET, 1]]);
  });

  it('does not report a document as linking to itself', () => {
    // It would appear in its own backlinks panel, which reads as a bug however it got there.
    const links = extractItemLinks(documentOf(reference(SOURCE), reference(TARGET)), SOURCE);

    expect([...links]).toEqual([[TARGET, 1]]);
  });

  it('skips references to people', () => {
    // `@` offers people as well as items, and a person is not somewhere a backlinks panel can
    // send you. They are rendered and resolved; they are not edges.
    const links = extractItemLinks(
      documentOf(reference(OTHER, 'principal'), reference(TARGET)),
      SOURCE,
    );

    expect([...links]).toEqual([[TARGET, 1]]);
  });

  it('drops a target that is not an identifier at all', () => {
    // The target comes out of a document, which means it comes from a browser. Sent on to a uuid
    // column it would fail the insert and take the whole snapshot with it - a document that
    // stops saving because of one bad link.
    for (const malformed of [
      'banana',
      '',
      '../../etc/passwd',
      "'; DROP TABLE item; --",
      42,
      null,
    ]) {
      expect([...extractItemLinks(documentOf(reference(malformed)), SOURCE)]).toEqual([]);
    }
  });

  it('ignores a reference with no attributes and a document that is not one', () => {
    expect([...extractItemLinks({ type: 'reference' }, SOURCE)]).toEqual([]);
    expect([...extractItemLinks({ type: 'reference', attrs: null }, SOURCE)]).toEqual([]);
    expect([...extractItemLinks(null, SOURCE)]).toEqual([]);
    expect([...extractItemLinks('not a document', SOURCE)]).toEqual([]);
  });

  it('returns nothing for a document with no references', () => {
    // The empty answer matters as much as a full one: it is what clears the edges of a document
    // whose last link was just deleted.
    const links = extractItemLinks(
      documentOf({ type: 'text', text: 'Nothing points anywhere' }),
      SOURCE,
    );

    expect(links.size).toBe(0);
  });

  it('survives a document nested deeply enough to overflow a recursive walk', () => {
    let node: unknown = { type: 'paragraph', content: [reference(TARGET)] };
    for (let depth = 0; depth < 50_000; depth += 1) {
      node = { type: 'blockquote', content: [node] };
    }

    expect([...extractItemLinks({ type: 'doc', content: [node] }, SOURCE)]).toEqual([[TARGET, 1]]);
  });
});

describe('bounding the text handed to the search index', () => {
  it('passes an ordinary document through untouched', () => {
    expect(boundSearchText('The plan\nShip it')).toBe('The plan\nShip it');
  });

  it('truncates text past what the server will accept', () => {
    // Postgres refuses a text search input over a megabyte outright. Truncating is the difference
    // between an enormous document being partly searchable and its snapshot failing to write.
    const enormous = 'a'.repeat(SEARCH_TEXT_CEILING + 1_000);

    expect(boundSearchText(enormous)).toHaveLength(SEARCH_TEXT_CEILING);
  });
});
