import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { calloutClass, headingClass, proseClasses, proseRoot } from './prose';

/**
 * The document's appearance, as class strings.
 *
 * These exist because of a bug worth remembering: the editor applied a class called `nix-prose`
 * that was defined nowhere, and Tailwind's reset strips heading sizes, list markers, blockquote
 * indents and table borders. Every block in a note rendered as identical plain text, so the rich
 * editor did not look plain - it looked broken.
 *
 * A class string cannot be tested by rendering it, so what is asserted here is what can go wrong
 * without anybody noticing: a node the schema defines with no appearance at all, and an arbitrary
 * value creeping back in. The second is the whole point of the phase these were written in, and a
 * regex sweep is a better guard than any number of examples.
 */

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'prose.ts'), 'utf8');

describe('coverage of the schema', () => {
  // Every node and mark the schema defines, less the ones whose appearance is their parent's
  // business: text has no element of its own, and the table parts are styled by the table.
  const NODES = [
    'paragraph',
    'bulletList',
    'orderedList',
    'listItem',
    'taskList',
    'taskItem',
    'blockquote',
    'codeBlock',
    'horizontalRule',
    'image',
    'table',
    'tableRow',
    'tableHeader',
    'tableCell',
  ];

  const MARKS = ['bold', 'italic', 'underline', 'strike', 'code', 'highlight', 'link'];

  it.each([...NODES, ...MARKS])('gives %s an appearance', (name) => {
    // A node with no entry renders with Tailwind's reset and nothing else, which is precisely the
    // state this file exists to end.
    expect(proseClasses[name], name).toBeDefined();
  });

  it('leaves the nodes with nothing to style alone', () => {
    // A hard break is a `<br>`: it has no box, no text of its own and nothing a class could
    // change. An entry for it would be a class nobody could see the effect of, which is worse
    // than none.
    expect(proseClasses.hardBreak).toBeUndefined();
  });

  it('leaves heading and callout to their own functions', () => {
    // Their appearance depends on an attribute, which a fixed string cannot express. Present in
    // this map, they would silently win over the renderer that reads the attribute.
    expect(proseClasses.heading).toBeUndefined();
    expect(proseClasses.callout).toBeUndefined();
  });
});

describe('headings', () => {
  it('makes the three levels distinguishable', () => {
    const levels = [1, 2, 3].map((level) => headingClass(level));

    // A hierarchy nobody can see is not a hierarchy. Distinct strings are the weakest form of that
    // assertion and the only one available without a browser.
    expect(new Set(levels).size).toBe(3);
  });

  it('renders a level this build does not define rather than dropping it', () => {
    // A document from a newer build shows its structure at the wrong rank instead of losing it.
    expect(headingClass(9)).toBe(headingClass(1));
    expect(headingClass(0)).toBe(headingClass(1));
  });
});

describe('callouts', () => {
  it('distinguishes the four tones', () => {
    const tones = ['note', 'tip', 'warning', 'danger'].map((tone) => calloutClass(tone));

    expect(new Set(tones).size).toBe(4);
  });

  it('falls back to note for a tone this build does not know', () => {
    // Matching the schema's own reading of the attribute: readable in the wrong tone beats
    // unreadable in no tone.
    expect(calloutClass('interstellar')).toBe(calloutClass('note'));
  });
});

describe('the values these strings are built from', () => {
  it('names no arbitrary type size', () => {
    // The defect this phase exists to remove. Twelve hand-picked sizes across the app were why it
    // read as unfinished; a `text-[15px]` here would put the thirteenth back.
    expect(source).not.toMatch(/text-\[\d/);
  });

  it('names no raw colour', () => {
    // A guard script enforces this repository-wide, but a hex in a class string is worth failing
    // here too, where the message says which file to look in.
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('uses the type scale', () => {
    // Not merely the absence of literals: the strings have to reach for the scale, or the document
    // inherits whatever the browser felt like.
    expect(source).toMatch(/\btext-(2xs|xs|sm|base|md|lg|xl|2xl|3xl)\b/);
  });

  it('keeps the document to a measure', () => {
    // Text running the full width of a wide pane is measurably harder to read.
    expect(proseRoot).toContain('max-w-prose');
  });

  it('styles what the ProseMirror runtime draws and no stylesheet covers', () => {
    // The selection, the gap cursor and the column resize handle come from packages whose
    // stylesheets we do not import, so without these they are in the DOM and invisible.
    expect(proseRoot).toContain('selection:');
    expect(proseRoot).toContain('ProseMirror-gapcursor');
    expect(proseRoot).toContain('column-resize-handle');
  });
});

describe('the grounds', () => {
  it('needs no dark variant anywhere', () => {
    // A component reaching for `dark:` has reached past the tokens for a colour. The semantic
    // roles move with the ground, so correct use of them is correct on both.
    expect(source).not.toContain('dark:');
  });
});
