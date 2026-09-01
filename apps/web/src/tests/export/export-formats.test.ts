import type { ExportFormat } from '@nix/api-client';
import { describe, expect, it } from 'vitest';

import {
  formatFor,
  formatPreamble,
  partialExportSummary,
  preferredFormat,
} from '../../export/export-formats';

const markdown: ExportFormat = {
  format: 'markdown',
  label: 'Markdown',
  extension: 'md',
  mediaType: 'text/markdown',
  lossless: false,
  declaredLoss: ['Interactive views become text.', 'Comments are omitted.'],
};
const archive: ExportFormat = {
  format: 'nix',
  label: 'Archive',
  extension: 'nix',
  mediaType: 'application/vnd.nix.archive+zip',
  lossless: true,
  declaredLoss: [],
};

describe('advertised export formats', () => {
  it('prefers whichever active format advertises itself as lossless', () => {
    expect(preferredFormat([markdown, archive])).toBe(archive);
  });

  it('uses the first advertised projection when no lossless worker is active', () => {
    expect(preferredFormat([markdown])).toBe(markdown);
    expect(preferredFormat([])).toBeUndefined();
  });

  it('finds formats by their advertised identifier without a hardcoded format union', () => {
    const pluginFormat = { ...markdown, format: 'epub', label: 'EPUB', extension: 'epub' };

    expect(formatFor([archive, pluginFormat], 'epub')).toBe(pluginFormat);
    expect(formatFor([archive], 'epub')).toBeUndefined();
  });

  it('shows the worker’s declared fidelity limits before a projected export starts', () => {
    const preamble = formatPreamble(markdown);

    expect(preamble).toContain('Interactive views become text.');
    expect(preamble).toContain('Comments are omitted.');
    expect(preamble).toContain('completed export repeats');
  });

  it('does not invent fidelity guarantees when a projected worker advertises no detail', () => {
    expect(formatPreamble({ ...markdown, declaredLoss: [] })).toContain(
      'did not advertise specific fidelity limits',
    );
  });

  it('states the lossless advertisement without naming a specific implementation', () => {
    expect(formatPreamble(archive)).toContain('advertised as lossless');
    expect(formatPreamble(archive)).not.toMatch(/media|collab/i);
  });
});

describe('the completed export report', () => {
  it('reports counts, fidelity changes, and omissions from the durable result', () => {
    const summary = partialExportSummary({
      itemCount: 42,
      omittedCount: 2,
      loss: ['A board became a static list.'],
      omissions: ['One deleted item was omitted.'],
    });

    expect(summary).toContain('42 items were exported');
    expect(summary).toContain('2 items were omitted');
    expect(summary).toContain('A board became a static list.');
    expect(summary).toContain('One deleted item was omitted.');
  });
});
