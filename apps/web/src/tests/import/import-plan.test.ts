import { describe, expect, it } from 'vitest';
import { EMPTY_MARKDOWN_IMPORT_SCAN } from '@nix/markdown/scan';

import { planImport, screenPaths, type ParseBody } from '../../import/import-plan';

/** The happy parser: everything is a valid body. Tests that need a failure inject their own. */
const parseOk: ParseBody = () => ({
  ok: true,
  doc: { type: 'doc' },
  scan: EMPTY_MARKDOWN_IMPORT_SCAN,
});

describe('screening a selection before reading it', () => {
  it('turns away what planning would skip, with the same reasons, before a byte is read', () => {
    const paths = ['vault/real.md', 'vault/image.png', 'vault/.obsidian/config.md'];
    const screened = screenPaths(paths);

    expect(screened.wanted).toEqual([true, false, false]);
    // The reasons match planImport's own, because both apply the one skip rule.
    expect(screened.skipped).toEqual([
      { path: 'vault/image.png', reason: 'not a Markdown file' },
      { path: 'vault/.obsidian/config.md', reason: 'inside a hidden directory, not imported' },
    ]);
  });

  it('lets a deliberately picked hidden folder through, the way planning does', () => {
    const screened = screenPaths(['.vault/a.md', '.vault/b.md']);
    expect(screened.wanted).toEqual([true, true]);
    expect(screened.skipped).toEqual([]);
  });

  it('carries its skips into the plan so the preview stays whole', () => {
    const screened = screenPaths(['vault/a.md', 'vault/pic.png']);
    const plan = planImport(
      [{ path: 'vault/a.md', text: 'Body.' }],
      () => ({ ok: true, doc: {}, scan: EMPTY_MARKDOWN_IMPORT_SCAN }),
      undefined,
      screened.skipped,
    );

    expect(plan.root?.children.map((child) => child.title)).toEqual(['a']);
    expect(plan.skipped).toEqual([{ path: 'vault/pic.png', reason: 'not a Markdown file' }]);
  });
});

describe('planning an import', () => {
  it('turns a picked folder into one root container named after it, folders inside into children', () => {
    const plan = planImport(
      [
        { path: 'vault/b-note.md', text: 'B.' },
        { path: 'vault/sub/deep.md', text: 'Deep.' },
        { path: 'vault/a-note.md', text: 'A.' },
      ],
      parseOk,
    );

    expect(plan.root?.title).toBe('vault');
    expect(plan.root?.children.map((child) => child.title)).toEqual(['a-note', 'b-note', 'sub']);
    const sub = plan.root?.children.find((child) => child.title === 'sub');
    expect(sub?.kind).toBe('container');
    expect(sub?.children.map((child) => child.title)).toEqual(['deep']);
    expect(plan.totalItems).toBe(5);
  });

  it('puts loose files under a plain root, because an import needs one handle to undo it', () => {
    const plan = planImport(
      [
        { path: 'one.md', text: 'One.' },
        { path: 'two.md', text: 'Two.' },
      ],
      parseOk,
    );

    expect(plan.root?.title).toBe('Imported notes');
    expect(plan.root?.children.map((child) => child.title)).toEqual(['one', 'two']);
  });

  it('orders titles by code unit so hosts and locales produce the same plan', () => {
    const plan = planImport(
      [
        { path: 'ä.md', text: 'A.' },
        { path: 'a.md', text: 'A.' },
        { path: 'Z.md', text: 'Z.' },
      ],
      parseOk,
    );

    expect(plan.root?.children.map((child) => child.title)).toEqual(['Z', 'a', 'ä']);
  });

  it('maps front matter to properties, with the title key naming the note', () => {
    const plan = planImport(
      [{ path: 'a.md', text: '---\ntitle: Named\nstatus: done\ncount: 5\n---\nBody.' }],
      parseOk,
    );

    const note = plan.root?.children[0];
    expect(note?.title).toBe('Named');
    expect(note?.properties).toEqual({ status: 'done', count: 5 });
  });

  it('declares what it cannot import - non-Markdown, hidden directories - instead of dropping it', () => {
    const plan = planImport(
      [
        { path: 'vault/real.md', text: 'Real.' },
        { path: 'vault/image.png', text: '' },
        { path: 'vault/.obsidian/config.md', text: 'tool config' },
      ],
      parseOk,
    );

    expect(plan.root?.children.map((child) => child.title)).toEqual(['real']);
    expect(plan.skipped).toEqual([
      { path: 'vault/image.png', reason: 'not a Markdown file' },
      { path: 'vault/.obsidian/config.md', reason: 'inside a hidden directory, not imported' },
    ]);
  });

  it('reports a body the document model rejects as failed, and keeps planning the rest', () => {
    const parse: ParseBody = (markdown) =>
      markdown.includes('bad')
        ? { ok: false, reason: 'no home for that' }
        : { ok: true, doc: {}, scan: EMPTY_MARKDOWN_IMPORT_SCAN };
    const plan = planImport(
      [
        { path: 'good.md', text: 'Fine.' },
        { path: 'broken.md', text: 'bad content' },
      ],
      parse,
    );

    expect(plan.root?.children.map((child) => child.title)).toEqual(['good']);
    expect(plan.failed).toEqual([
      { path: 'broken.md', reason: 'not a valid note body: no home for that' },
    ]);
  });

  it('uses the parser scan instead of guessing losses from the source again', () => {
    const observed = {
      unresolvedWikiLinks: 2,
      unresolvedObsidianEmbeds: 3,
      unresolvedLocalImages: 4,
      unsupportedImageAddresses: 6,
      inlineImagesFlattened: 5,
    };
    const plan = planImport(
      [
        {
          path: 'a.md',
          text: 'A [[Link]] and ![pic](./img.png) and ![web](https://example.test/x.png).',
        },
      ],
      () => ({ ok: true, doc: { type: 'doc' }, scan: observed }),
    );

    const note = plan.root?.children[0];
    expect(note?.scan).toBe(observed);
    expect(plan.root?.scan).toBe(EMPTY_MARKDOWN_IMPORT_SCAN);
  });

  it('returns no root when nothing importable was chosen', () => {
    const plan = planImport([{ path: 'photo.jpg', text: '' }], parseOk);
    expect(plan.root).toBeNull();
    expect(plan.totalItems).toBe(0);
    expect(plan.skipped).toHaveLength(1);
  });
});
