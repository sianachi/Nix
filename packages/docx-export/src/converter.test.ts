import { PRINT_PALETTE } from '@nix/design-tokens/print';
import { FIXTURE_DOCUMENT, NODE_FIXTURES } from '@nix/editor-schema';
import {
  createLossReport,
  visitProse,
  type ArchiveManifest,
  type ConvertRequest,
  type ItemBundle,
  type LossKind,
  type ViewsSnapshot,
} from '@nix/export';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { buildBlocks, docxConverter } from './converter.js';
import { nodeHandlers } from './nodes.js';

/**
 * The DOCX converter.
 *
 * **Structure, then one end-to-end unzip.** A DOCX is a zip, so asserting on output bytes tests the
 * compressor rather than the mapping. What is checked is what the mapping decided, plus that the
 * package it produces is one Word would recognise: the parts are present and the text is in them.
 */

function bundle(overrides: Partial<ItemBundle> = {}): ItemBundle {
  return {
    id: '0199c0de-0000-7000-8000-000000000001',
    parentId: null,
    workspaceId: '0199c0de-0000-7000-8000-000000000009',
    type: 'note',
    title: 'Quarterly Review',
    seq: '1000',
    lifecycleState: 'active',
    createdAt: '2026-08-13T00:00:00Z',
    updatedAt: '2026-08-13T00:00:00Z',
    properties: {},
    schema: null,
    views: null,
    viewRows: [],
    viewRowsTruncated: false,
    body: { schemaVersion: 2, prosemirror: FIXTURE_DOCUMENT },
    ...overrides,
  };
}

async function* bundlesOf(...items: readonly ItemBundle[]): AsyncGenerator<ItemBundle> {
  for (const item of items) {
    yield await Promise.resolve(item);
  }
}

function requestFor(items: readonly ItemBundle[]): ConvertRequest {
  const manifest: ArchiveManifest = {
    format: 'nix-archive',
    formatVersion: 1,
    schemaVersion: 2,
    exportedAt: '2026-08-13T00:00:00Z',
    root: '0199c0de-0000-7000-8000-000000000001',
    rootEffectiveSchema: null,
    includesDeleted: false,
    items: [],
    omitted: [],
    loss: [],
  };

  return {
    manifest,
    bundles: bundlesOf(...items),
    branding: {
      title: 'Quarterly Review',
      exportedAt: new Date('2026-08-13T00:00:00Z'),
      palette: PRINT_PALETTE,
    },
  };
}

async function convert(...items: readonly ItemBundle[]): Promise<Buffer> {
  const chunks: Uint8Array[] = [];

  for await (const chunk of docxConverter.convert(requestFor(items))) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function build(...items: readonly ItemBundle[]) {
  return await buildBlocks(requestFor(items));
}

/** The loss kinds the fixture document actually produces when mapped. */
function observedKinds(): ReadonlySet<LossKind> {
  const report = createLossReport();
  visitProse(FIXTURE_DOCUMENT, nodeHandlers, { itemId: 'item', report });
  return report.kinds();
}

describe('what the DOCX converter says it loses', () => {
  it('declares every kind the fixture document actually produces', () => {
    const declared = new Set(docxConverter.declaredLoss().map((notice) => notice.kind));

    for (const kind of observedKinds()) {
      expect(declared).toContain(kind);
    }
  });

  it('loses exactly the five things a document of every block should lose', () => {
    // A set, not a subset: a new loss appearing in the mapping fails here rather than passing.
    expect([...observedKinds()].sort()).toEqual([
      'columns-as-table',
      'comment-dropped',
      'disclosure-expanded',
      'image-not-embedded',
      'reference-flattened',
    ]);
  });

  it('says each of them in a sentence somebody could act on', () => {
    for (const notice of docxConverter.declaredLoss()) {
      expect(notice.detail).toMatch(/^[A-Z].*\.$/);
    }
  });
});

describe('the columns Open XML cannot express', () => {
  it('is the one loss this format has and the PDF does not', () => {
    const report = createLossReport();

    visitProse({ type: 'doc', content: [NODE_FIXTURES.columnBlock] }, nodeHandlers, {
      itemId: 'item',
      report,
    });

    expect([...report.kinds()]).toContain('columns-as-table');
  });

  it('still puts the content side by side, in one borderless row', async () => {
    const { blocks } = await build(
      bundle({
        body: {
          schemaVersion: 2,
          prosemirror: { type: 'doc', content: [NODE_FIXTURES.columnBlock] },
        },
      }),
    );

    const table = blocks.find((block) => block.kind === 'table' && block.borderless === true);

    expect(table).toBeDefined();
    expect(table?.kind === 'table' ? table.rows[0] : []).toHaveLength(2);
  });
});

describe('a list item', () => {
  it('keeps its text when it is turned into a numbered item', async () => {
    // The bug an eager mapper has: docx reads a Paragraph's options at construction and exposes
    // none of them, so decorating one by rebuilding it silently drops its children.
    const { blocks } = await build(
      bundle({
        body: {
          schemaVersion: 2,
          prosemirror: { type: 'doc', content: [NODE_FIXTURES.orderedList] },
        },
      }),
    );

    const item = blocks.find((block) => block.kind === 'paragraph' && block.list !== undefined);

    expect(item?.kind === 'paragraph' ? item.inlines : []).not.toHaveLength(0);
  });

  it('carries the nesting level Word numbers by', async () => {
    const { blocks } = await build(
      bundle({
        body: {
          schemaVersion: 2,
          prosemirror: { type: 'doc', content: [NODE_FIXTURES.bulletList] },
        },
      }),
    );

    const levels = blocks
      .filter((block) => block.kind === 'paragraph' && block.list !== undefined)
      .map((block) => (block.kind === 'paragraph' ? block.list?.level : undefined));

    expect(levels).toContain(0);
    expect(levels).toContain(1);
  });
});

describe('producing the file', () => {
  it('is a Word package with the parts Word looks for', async () => {
    const entries = unzipSync(new Uint8Array(await convert(bundle())));

    expect(Object.keys(entries)).toEqual(
      expect.arrayContaining(['[Content_Types].xml', 'word/document.xml', 'word/numbering.xml']),
    );
  });

  it('holds the document text', async () => {
    const entries = unzipSync(new Uint8Array(await convert(bundle())));
    const xml = Buffer.from(entries['word/document.xml'] ?? new Uint8Array()).toString();

    expect(xml).toContain('Quarterly Review');
    expect(xml).toContain('A paragraph.');
    // The ASCII marker CLAUDE.md mandates, rather than a symbol from a font Word may not have.
    expect(xml).toContain('[x] ');
  });
});

describe('an item with no body', () => {
  it('is not reported as a loss, because there was nothing to lose', async () => {
    const { report } = await build(bundle({ body: null }));

    expect(report.isEmpty()).toBe(true);
  });
});

describe('a canvas item', () => {
  it('is left out, and the file itself says so', async () => {
    const { report, blocks } = await build(
      bundle({ type: 'canvas', body: { schemaVersion: 1, canvas: { elements: {} } } }),
    );

    expect([...report.kinds()]).toEqual(['body-not-rendered']);
    expect(JSON.stringify(blocks)).toContain('What did not come across');
  });
});

/**
 * Views, as pictures in a Word document.
 *
 * Open XML embeds pictures as bytes, so this path needs the host to turn a drawing into one. What
 * the tests pin is that it asks, that it degrades honestly when nothing answers, and that the
 * picture it embeds is a real PNG rather than an empty run.
 */
const BOARD: ViewsSnapshot = {
  views: [
    {
      id: 'v1',
      name: 'By status',
      kind: 'board',
      columns: [],
      groupBy: 'status',
      groupOrder: [],
      dateProperty: null,
      sortBy: null,
      sortDescending: false,
      mode: null,
      coverProperty: null,
      endDateProperty: null,
      cardSize: null,
    },
  ],
  default: 'v1',
};

/** The eight bytes every PNG starts with, which is all a fake needs to be embeddable. */
const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function withBoard() {
  return bundle({
    body: null,
    views: BOARD,
    viewRows: [{ id: 'a', title: 'Draft the brief', properties: { status: 'Todo' } }],
  });
}

describe('an item that offers a view', () => {
  it('asks the host to turn the drawing into a picture', async () => {
    const seen: { svg?: string; width?: number } = {};

    await buildBlocks({
      ...requestFor([withBoard()]),
      host: {
        rasterise: (svg, width) => {
          seen.svg = svg;
          seen.width = width;
          return Promise.resolve(PNG_HEADER);
        },
      },
    });

    expect(seen.svg).toContain('<svg');
    expect(seen.svg).toContain('Draft the brief');
    // Drawn larger than it is placed, so the picture still reads when somebody zooms in.
    expect(seen.width).toBeGreaterThan(468);
  });

  it('says a picture is what it is', async () => {
    const { report } = await buildBlocks({
      ...requestFor([withBoard()]),
      host: { rasterise: () => Promise.resolve(PNG_HEADER) },
    });

    expect([...report.kinds()]).toContain('views-as-image');
  });

  it('says so rather than failing when the host cannot make a picture', async () => {
    // The capability is optional, so a host without one degrades to a stated loss instead of an
    // error - which is what makes it a capability rather than a hidden requirement.
    const { report, blocks } = await buildBlocks(requestFor([withBoard()]));

    expect([...report.kinds()]).toContain('views-as-image');
    expect(report.entries()[0]?.detail).toContain('cannot turn a drawing into a picture');
    expect(JSON.stringify(blocks)).not.toContain('By status');
  });

  it('puts a real picture into the package', async () => {
    const chunks: Uint8Array[] = [];

    for await (const chunk of docxConverter.convert({
      ...requestFor([withBoard()]),
      host: { rasterise: () => Promise.resolve(PNG_HEADER) },
    })) {
      chunks.push(chunk);
    }

    const entries = unzipSync(new Uint8Array(Buffer.concat(chunks)));
    const media = Object.keys(entries).filter((name) => name.startsWith('word/media/'));

    expect(media).not.toHaveLength(0);
  });
});
