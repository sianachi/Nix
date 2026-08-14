import { describe, expect, it } from 'vitest';

import { EXPORT_FORMATS, formatFor, type ExportFormat } from '../../export/export-formats';

/**
 * The formats offered, and the promises made about them.
 *
 * The substantive guarantee - that what somebody is told matches what the converter actually drops
 * - is enforced in the converter packages, where `declaredLoss()` is asserted to cover every loss a
 * document of every block produces. Those packages are Node-only, so this suite checks the part
 * that lives here: that the copy exists, names specifics, and points at where the file repeats it.
 */

describe('the formats on offer', () => {
  it('offers the lossless one and the two lossy ones', () => {
    expect(EXPORT_FORMATS.map((format) => format.value)).toEqual(['nix', 'pdf', 'docx']);
  });

  it('sends the lossless one to the service that holds the documents', () => {
    // Not the media service, deliberately: leaving with everything cannot depend on a converter.
    expect(formatFor('nix').baseUrl).toBe('/collab');
    expect(formatFor('pdf').baseUrl).toBe('/media');
    expect(formatFor('docx').baseUrl).toBe('/media');
  });

  it('says what each lossy format will not carry, in specifics rather than hedges', () => {
    for (const format of ['pdf', 'docx'] as const) {
      const { preamble } = formatFor(format);

      // The three a person is most likely to notice missing, named rather than gestured at.
      expect(preamble).toContain('Comments');
      expect(preamble).toContain('images stored elsewhere');
      expect(preamble).toMatch(/collapsed section/);
    }
  });

  it('claims no loss for the archive, which is the one format that has none', () => {
    expect(formatFor('nix').preamble).toContain('without losing anything');
  });

  it('says where the file repeats what it left out', () => {
    expect(formatFor('pdf').reportLocation).toContain('last page');
    expect(formatFor('docx').reportLocation).toContain('last section');
    expect(formatFor('nix').reportLocation).toContain('manifest');
  });

  it('gives every format a file extension of its own', () => {
    const extensions = EXPORT_FORMATS.map((format) => format.extension);

    expect(new Set(extensions).size).toBe(extensions.length);
  });

  it('refuses a format it does not have rather than falling back to one it does', () => {
    // Falling back would export a format nobody asked for, which is worse than an error.
    expect(() => formatFor('markdown' as ExportFormat)).toThrow(/no export format/);
  });
});

describe('what the copy says about views', () => {
  it('tells somebody a board becomes a picture, before they choose', () => {
    // A view is the thing an item is *for* in a workspace that uses boards, so "it became a
    // picture" is the sentence most likely to change which format somebody picks.
    for (const format of ['pdf', 'docx'] as const) {
      expect(formatFor(format).preamble).toMatch(/[Bb]oards, calendars and galleries/);
    }
  });

  it('says what a picture cannot do, rather than only that it is one', () => {
    expect(formatFor('pdf').preamble).toContain('cannot be sorted or clicked');
    expect(formatFor('docx').preamble).toContain('cannot be edited');
  });
});
