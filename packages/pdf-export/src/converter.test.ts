import { FIXTURE_DOCUMENT, NODE_FIXTURES } from '@nix/editor-schema';
import { PRINT_PALETTE } from '@nix/design-tokens/print';
import {
  createLossReport,
  visitProse,
  type ArchiveManifest,
  type ConvertRequest,
  type ItemBundle,
  type LossKind,
  type ViewsSnapshot,
} from '@nix/export';
import { describe, expect, it } from 'vitest';

import { buildContent, pdfConverter } from './converter.js';
import { nodeHandlers } from './nodes.js';

/**
 * The PDF converter.
 *
 * **Structure, not bytes.** PDFKit embeds a creation date and a document identifier, and font
 * subsetting is not stable across patch versions, so a byte-golden fixture would go red on a
 * dependency bump with nothing wrong. What is asserted is what the mapping decided, plus one
 * end-to-end run proving the bytes are a PDF at all.
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

function manifest(): ArchiveManifest {
  return {
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
}

async function* bundlesOf(...items: readonly ItemBundle[]): AsyncGenerator<ItemBundle> {
  for (const item of items) {
    yield await Promise.resolve(item);
  }
}

function requestFor(items: readonly ItemBundle[]): ConvertRequest {
  return {
    manifest: manifest(),
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

  for await (const chunk of pdfConverter.convert(requestFor(items))) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function build(...items: readonly ItemBundle[]) {
  return await buildContent(requestFor(items));
}

/** The loss kinds the fixture document actually produces when drawn. */
function observedKinds(): ReadonlySet<LossKind> {
  const report = createLossReport();

  visitProse(FIXTURE_DOCUMENT, nodeHandlers, { itemId: 'item', report });

  return report.kinds();
}

describe('what the PDF converter says it loses', () => {
  it('declares every kind the fixture document actually produces', () => {
    // The test that makes the dialog's promise enforceable: whatever somebody is told before they
    // press Export must cover what a document exercising every block goes on to lose.
    const declared = new Set(pdfConverter.declaredLoss().map((notice) => notice.kind));

    for (const kind of observedKinds()) {
      expect(declared).toContain(kind);
    }
  });

  it('loses exactly the four things a document of every block should lose', () => {
    // Asserted as a set rather than a subset, so a new loss appearing in the mapping fails here
    // instead of passing quietly.
    expect([...observedKinds()].sort()).toEqual([
      'comment-dropped',
      'disclosure-expanded',
      'image-not-embedded',
      'reference-flattened',
    ]);
  });

  it('says each of them in a sentence somebody could act on', () => {
    for (const notice of pdfConverter.declaredLoss()) {
      expect(notice.detail).toMatch(/^[A-Z].*\.$/);
    }
  });
});

describe('drawing a document', () => {
  it('produces a PDF', async () => {
    const pdf = await convert(bundle());

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.subarray(-6).toString().trim()).toBe('%%EOF');
  });

  it('embeds the interface typeface rather than a second one', async () => {
    const pdf = await convert(bundle());

    expect(pdf.includes(Buffer.from('NunitoSans'))).toBe(true);
    expect(pdf.includes(Buffer.from('Roboto'))).toBe(false);
  });

  it('renders a body a newer build wrote, minus the block it cannot draw', () => {
    const report = createLossReport();

    const drawn = visitProse(
      { type: 'doc', content: [{ type: 'timeline' }, NODE_FIXTURES.paragraph] },
      nodeHandlers,
      { itemId: 'item', report },
    );

    expect(drawn).not.toBeNull();
    expect([...report.kinds()]).toEqual(['unknown-node']);
  });

  it('renders an unknown text colour as the default rather than refusing the document', () => {
    // MARK_FIXTURES.textColor deliberately carries 'danger', a value the closed set does not hold.
    const report = createLossReport();

    const drawn = visitProse(FIXTURE_DOCUMENT, nodeHandlers, { itemId: 'item', report });

    expect(drawn).not.toBeNull();
    expect(JSON.stringify(drawn)).toContain(PRINT_PALETTE.ink);
  });
});

describe('an item with no body', () => {
  it('is not reported as a loss, because there was nothing to lose', async () => {
    const { report, content } = await build(bundle({ body: null }));

    expect(report.isEmpty()).toBe(true);
    expect(JSON.stringify(content)).not.toContain('What did not come across');
  });
});

describe('a canvas item', () => {
  it('is left out, and the file itself says so', async () => {
    const { report, content } = await build(
      bundle({ type: 'canvas', body: { schemaVersion: 1, canvas: { elements: {} } } }),
    );

    expect([...report.kinds()]).toEqual(['body-not-rendered']);
    // The appendix is the only place left to say it: the headers went out before the body was read.
    expect(JSON.stringify(content)).toContain('What did not come across');
  });
});

describe('a subtree', () => {
  it('starts each item after the first on its own page', async () => {
    const { content } = await build(
      bundle({ body: null }),
      bundle({ id: '0199c0de-0000-7000-8000-000000000002', title: 'Second', body: null }),
    );

    const breaks = content.filter((node) => node.pageBreak === 'before');
    expect(breaks).toHaveLength(1);
  });
});

/**
 * Views, drawn into the page.
 *
 * A board or a calendar used to be a loss entry saying the views were not included. It is now a
 * picture, and what a picture cannot do - be sorted, grouped or clicked - is what the report says
 * instead.
 */
const BOARD: ViewsSnapshot = {
  views: [
    {
      id: 'v1',
      name: 'By status',
      kind: 'board',
      columns: [],
      groupBy: 'status',
      groupOrder: ['Todo', 'Done'],
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

describe('an item that offers a view', () => {
  const withBoard = () =>
    bundle({
      body: null,
      views: BOARD,
      viewRows: [
        { id: 'a', title: 'Draft the brief', properties: { status: 'Todo' } },
        { id: 'b', title: 'Ship it', properties: { status: 'Done' } },
      ],
    });

  it('draws it as vector, which a page prints at whatever resolution it is printed at', async () => {
    const { content } = await build(withBoard());

    const drawing = content.find((node) => node.svg !== undefined);

    expect(drawing?.svg).toContain('<svg');
    expect(drawing?.svg).toContain('Draft the brief');
    expect(drawing?.svg).toContain('Ship it');
  });

  it('names the view above its picture, so a page with two says which is which', async () => {
    const { content } = await build(withBoard());

    expect(JSON.stringify(content)).toContain('By status');
  });

  it('says a picture is what it is, rather than claiming the view came across whole', async () => {
    const { report } = await build(withBoard());

    expect([...report.kinds()]).toContain('views-as-image');
  });

  it('draws it above the body, the way the item opens', async () => {
    const { content } = await build(
      bundle({
        views: BOARD,
        viewRows: [{ id: 'a', title: 'A card', properties: {} }],
      }),
    );

    const drawing = content.findIndex((node) => node.svg !== undefined);
    const body = content.findIndex((node) => node.stack !== undefined);

    expect(drawing).toBeGreaterThan(-1);
    expect(drawing).toBeLessThan(body);
  });

  it('admits when it drew only the first of what is inside', async () => {
    const { report } = await build(
      bundle({ body: null, views: BOARD, viewRows: [], viewRowsTruncated: true }),
    );

    expect([...report.kinds()]).toContain('view-rows-truncated');
  });

  it('draws nothing extra for an item that offers no view', async () => {
    const { content } = await build(bundle({ body: null }));

    expect(content.find((node) => node.svg !== undefined)).toBeUndefined();
  });
});
