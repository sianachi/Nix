import { describe, expect, it } from 'vitest';
import { noteFromMarkdown, parseScalar, splitFrontMatter } from './front-matter.js';

describe('splitFrontMatter', () => {
  it('maps flat key: value lines to properties and returns the body without the fence', () => {
    const split = splitFrontMatter('---\ntitle: My Note\ncount: 5\ndone: true\n---\nBody here.\n');
    expect(split.properties).toEqual({ title: 'My Note', count: 5, done: true });
    expect(split.body).toBe('Body here.\n');
    expect(split.dropped).toEqual([]);
  });

  it('declares a line it cannot map as dropped rather than losing it silently', () => {
    const split = splitFrontMatter(
      '---\nok: yes\n- a list item\nnested:\n  child: 1\n---\nBody.\n',
    );
    expect(split.properties).toEqual({ ok: 'yes' });
    expect(split.dropped).toContain('- a list item');
    expect(split.dropped).toContain('child: 1');
  });

  it('drops a key with no value instead of fabricating an empty property', () => {
    const split = splitFrontMatter('---\nempty:\nreal: here\n---\nBody.\n');
    expect(split.properties).toEqual({ real: 'here' });
    expect(split.dropped).toEqual(['empty:']);
  });

  it('treats an unclosed fence as body, not metadata', () => {
    const text = '---\nnot: front matter without a close\n';
    const split = splitFrontMatter(text);
    expect(split.properties).toEqual({});
    expect(split.body).toBe(text);
  });

  it('leaves a document with no fence untouched', () => {
    const split = splitFrontMatter('Just a body.\n');
    expect(split.properties).toEqual({});
    expect(split.body).toBe('Just a body.\n');
    expect(split.dropped).toEqual([]);
  });
});

describe('noteFromMarkdown', () => {
  it('names the note from front matter title, consuming the key', () => {
    const note = noteFromMarkdown('---\ntitle: Named\nstatus: done\n---\nBody.', 'file.md');
    expect(note.title).toBe('Named');
    expect(note.properties).toEqual({ status: 'done' });
  });

  it('falls back to the file name without its extension when no title is given', () => {
    expect(noteFromMarkdown('Body.', 'my-note.md').title).toBe('my-note');
    expect(noteFromMarkdown('Body.', 'no-extension').title).toBe('no-extension');
  });

  it('ignores a title that is not a non-empty string', () => {
    expect(noteFromMarkdown('---\ntitle: 5\n---\nBody.', 'a.md').title).toBe('a');
    expect(noteFromMarkdown('---\ntitle: "  "\n---\nBody.', 'a.md').title).toBe('a');
  });
});

describe('parseScalar', () => {
  it('reads JSON scalars as their values and everything else as the raw text', () => {
    expect(parseScalar('5')).toBe(5);
    expect(parseScalar('true')).toBe(true);
    expect(parseScalar('null')).toBeNull();
    expect(parseScalar('"quoted"')).toBe('quoted');
    expect(parseScalar('done')).toBe('done');
    expect(parseScalar('2026-01-01')).toBe('2026-01-01');
  });
});
