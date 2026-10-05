import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';

import { nixExtensions } from './extensions.js';

/**
 * The `setTextColor` and `setTextBackground` commands, exercised where they live.
 *
 * Headless on purpose - `element: null` leaves the editor unmounted, so these run in the same
 * Node environment as the schema tests and prove the command needs no DOM: the collaboration
 * service builds this same extension list in Node, and a command that only worked mounted would
 * be a web-only feature hiding in a shared package.
 *
 * The assertions read `getJSON`, not HTML, because the stored document is the thing the rules
 * protect: what a colour looks like is the web app's stylesheet's business.
 */

let editor: Editor | null = null;

/** A headless editor over one paragraph, with its text selected. */
function selectedText(): Editor {
  editor = new Editor({
    element: null,
    extensions: nixExtensions,
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'some words' }] }],
    },
  });
  editor.commands.setTextSelection({ from: 1, to: 11 });
  return editor;
}

/** One mark as the document holds it: the name it stores under, and what it stores. */
interface StoredMark {
  readonly type: string;
  readonly attrs: unknown;
}

/**
 * The marks on the first text node.
 *
 * Read off the ProseMirror document rather than out of `getJSON()`, because the document is
 * what the collaboration service validates and what a CRDT update carries - and walking a
 * serialised tree would mean four levels of "this key may be absent" to say one thing.
 */
function storedMarks(current: Editor): readonly StoredMark[] {
  const found: StoredMark[] = [];
  let seenText = false;

  current.state.doc.descendants((node) => {
    if (!node.isText || seenText) {
      return !seenText;
    }
    seenText = true;
    for (const mark of node.marks) {
      const attrs: unknown = mark.attrs;
      found.push({ type: mark.type.name, attrs });
    }
    return false;
  });

  return found;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe('the setTextColor command', () => {
  it('stores a token name, never a colour value', () => {
    const current = selectedText();

    current.commands.setTextColor('accent');

    expect(storedMarks(current)).toEqual([
      { type: 'textColor', attrs: { text: 'accent', background: null } },
    ]);
  });

  it('removes the mark entirely when default is chosen and nothing else remains on it', () => {
    const current = selectedText();

    current.commands.setTextColor('muted');
    current.commands.setTextColor('default');

    // Cleared, not stored: writing `text: 'default'` would pin today's meaning of ordinary
    // text into the document forever.
    expect(storedMarks(current)).toEqual([]);
  });

  it('keeps a background while clearing the text colour, so no orphan is dropped with it', () => {
    const current = selectedText();

    current.commands.setMark('textColor', { background: 'accent' });
    current.commands.setTextColor('muted');
    current.commands.setTextColor('default');

    expect(storedMarks(current)).toEqual([
      { type: 'textColor', attrs: { text: null, background: 'accent' } },
    ]);
  });

  it('keeps a background it has never heard of when clearing the text colour', () => {
    const current = selectedText();

    // A newer build's colour, stored by a client this build has never met. The fallback-at-
    // render rule says the value survives and only the drawing degrades - so clearing the
    // foreground here must not use the render-time normalisation to decide the mark's fate,
    // or the unknown background would be silently deleted from the shared document.
    current.commands.setMark('textColor', { background: 'chartreuse' });
    current.commands.setTextColor('muted');
    current.commands.setTextColor('default');

    expect(storedMarks(current)).toEqual([
      { type: 'textColor', attrs: { text: null, background: 'chartreuse' } },
    ]);
  });

  it('treats a stored default background as no background at all', () => {
    const current = selectedText();

    // `'default'` is the one stored value that genuinely means "none", for a background as for
    // a foreground - a mark carrying only defaults says nothing and must not linger.
    current.commands.setMark('textColor', { background: 'default' });
    current.commands.setTextColor('default');

    expect(storedMarks(current)).toEqual([]);
  });
});

describe('the setTextBackground command', () => {
  it('stores a token name, never a colour value', () => {
    const current = selectedText();

    current.commands.setTextBackground('accent');

    expect(storedMarks(current)).toEqual([
      { type: 'textColor', attrs: { text: null, background: 'accent' } },
    ]);
  });

  it('removes the mark entirely when default is chosen and nothing else remains on it', () => {
    const current = selectedText();

    current.commands.setTextBackground('muted');
    current.commands.setTextBackground('default');

    // The mirror of the foreground's rule: `background: 'default'` would pin "no wash" into the
    // document as a stored decision, when the absence of the mark already says it.
    expect(storedMarks(current)).toEqual([]);
  });

  it('keeps the text colour while clearing the background, so no orphan is dropped with it', () => {
    const current = selectedText();

    current.commands.setTextColor('accent');
    current.commands.setTextBackground('muted');
    current.commands.setTextBackground('default');

    expect(storedMarks(current)).toEqual([
      { type: 'textColor', attrs: { text: 'accent', background: null } },
    ]);
  });

  it('keeps a text colour it has never heard of when clearing the background', () => {
    const current = selectedText();

    // The other direction of the case `setTextColor` already guards: an unknown value from a
    // newer build survives in the CRDT and only its drawing falls back, so the clearing rule
    // must not read it through the render-time normalisation and delete it.
    current.commands.setMark('textColor', { text: 'chartreuse' });
    current.commands.setTextBackground('muted');
    current.commands.setTextBackground('default');

    expect(storedMarks(current)).toEqual([
      { type: 'textColor', attrs: { text: 'chartreuse', background: null } },
    ]);
  });

  it('treats a stored default text colour as no text colour at all', () => {
    const current = selectedText();

    current.commands.setMark('textColor', { text: 'default' });
    current.commands.setTextBackground('default');

    expect(storedMarks(current)).toEqual([]);
  });

  it('sets the two axes independently, and neither clears the other', () => {
    const current = selectedText();

    current.commands.setTextColor('accent');
    current.commands.setTextBackground('muted');

    expect(storedMarks(current)).toEqual([
      { type: 'textColor', attrs: { text: 'accent', background: 'muted' } },
    ]);

    // Clearing both, one at a time, in either order, ends where it started: with no mark.
    current.commands.setTextColor('default');
    current.commands.setTextBackground('default');

    expect(storedMarks(current)).toEqual([]);
  });
});
