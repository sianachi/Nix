import { FIXTURE_DOCUMENT, NODE_FIXTURES, nixSchema } from '@nix/editor-schema';
import { describe, expect, it } from 'vitest';

import { createLossReport, type LossReport } from './loss.js';
import {
  PROSE_MARKS,
  PROSE_NODES,
  readBoolean,
  readNumber,
  readString,
  visitProse,
  type NodeHandlers,
  type ProseNode,
  type VisitContext,
  type VisitRequest,
} from './visit.js';

/** A handler set that records what it saw and rebuilds the tree, so nothing is dropped by accident. */
function recordingHandlers(seen: string[]): NodeHandlers<ProseNode> {
  const record: (node: ProseNode, ctx: VisitContext, children: () => ProseNode[]) => ProseNode = (
    node,
    _ctx,
    children,
  ) => {
    seen.push(node.type);
    children();
    return node;
  };

  return Object.fromEntries(PROSE_NODES.map((name) => [name, record])) as NodeHandlers<ProseNode>;
}

function request(report: LossReport = createLossReport()): VisitRequest {
  return { itemId: 'item', report };
}

describe('the node and mark lists', () => {
  it('names every node the schema declares, so a new block cannot ship unmapped', () => {
    expect([...PROSE_NODES].sort()).toEqual(Object.keys(nixSchema.nodes).sort());
  });

  it('names every mark the schema declares', () => {
    expect([...PROSE_MARKS].sort()).toEqual(Object.keys(nixSchema.marks).sort());
  });
});

describe('visiting a document', () => {
  it('reaches every node the schema has a fixture for, so no block goes unvisited', () => {
    const seen: string[] = [];

    visitProse(FIXTURE_DOCUMENT, recordingHandlers(seen), request());

    for (const name of Object.keys(NODE_FIXTURES)) {
      expect(seen).toContain(name);
    }
  });

  it('carries the depth down, so a mapper that flattens can recover the nesting', () => {
    const depths: Record<string, number> = {};
    const handlers = Object.fromEntries(
      PROSE_NODES.map((name) => [
        name,
        (node: ProseNode, ctx: VisitContext, children: () => unknown[]) => {
          depths[node.type] ??= ctx.depth;
          children();
          return node;
        },
      ]),
    ) as NodeHandlers<ProseNode>;

    visitProse({ type: 'doc', content: [NODE_FIXTURES.bulletList] }, handlers, request());

    expect(depths.doc).toBe(0);
    expect(depths.bulletList).toBe(1);
    expect(depths.listItem).toBe(2);
  });

  it('drops a node whose handler returns null without dropping its siblings', () => {
    const handlers = recordingHandlers([]);
    const kept: string[] = [];

    visitProse(
      { type: 'doc', content: [NODE_FIXTURES.heading, NODE_FIXTURES.paragraph] },
      {
        ...handlers,
        heading: () => null,
        doc: (node, _ctx, children) => {
          for (const child of children()) {
            kept.push(child.type);
          }

          return node;
        },
      },
      request(),
    );

    expect(kept).toEqual(['paragraph']);
  });
});

describe('a body that cannot be drawn', () => {
  it('returns null for a body that is not a document', () => {
    expect(visitProse(null, recordingHandlers([]), request())).toBeNull();
    expect(visitProse({ type: 'paragraph' }, recordingHandlers([]), request())).toBeNull();
    expect(visitProse('not a document', recordingHandlers([]), request())).toBeNull();
  });

  it('always records why, so a converter never has to remember to say a body went missing', () => {
    const report = createLossReport();

    visitProse({ type: 'paragraph' }, recordingHandlers([]), request(report));

    expect(report.entries()).toEqual([
      {
        itemId: 'item',
        kind: 'body-not-rendered',
        detail: 'This document could not be read and was left out of this file.',
      },
    ]);
  });
});

describe('content this build cannot read', () => {
  it('records a node a newer build wrote rather than refusing the whole document', () => {
    const report = createLossReport();
    const seen: string[] = [];

    visitProse(
      { type: 'doc', content: [{ type: 'timeline', content: [] }, NODE_FIXTURES.paragraph] },
      recordingHandlers(seen),
      request(report),
    );

    expect(seen).toContain('paragraph');
    expect([...report.kinds()]).toEqual(['unknown-node']);
  });

  it('drops an unknown block together with its children, and says so', () => {
    const report = createLossReport();
    const seen: string[] = [];

    visitProse(
      { type: 'doc', content: [{ type: 'timeline', content: [NODE_FIXTURES.paragraph] }] },
      recordingHandlers(seen),
      request(report),
    );

    expect(seen).not.toContain('paragraph');
    expect(report.entries()[0]?.detail).toContain('everything inside it');
  });

  it('records content that is not a node at all, so a corrupt archive cannot look clean', () => {
    const report = createLossReport();

    visitProse(
      { type: 'doc', content: ['not a node', { type: 42 }, NODE_FIXTURES.paragraph] },
      recordingHandlers([]),
      request(report),
    );

    expect(report.entries()).toEqual([
      {
        itemId: 'item',
        kind: 'malformed-node',
        detail:
          'Something inside a "doc" block was not readable and was left out. This happened 2 times.',
      },
    ]);
  });

  it('records a mark a newer build wrote and keeps the ones it knows', () => {
    const report = createLossReport();
    const marks: string[] = [];
    const handlers = recordingHandlers([]);

    visitProse(
      {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'formatted', marks: [{ type: 'bold' }, { type: 'sparkle' }] },
            ],
          },
        ],
      },
      {
        ...handlers,
        text: (node) => {
          marks.push(...node.marks.map((mark) => mark.type));
          return node;
        },
      },
      request(report),
    );

    expect(marks).toEqual(['bold']);
    expect([...report.kinds()]).toEqual(['unknown-mark']);
  });
});

describe('reading attributes', () => {
  it('returns null for a missing, empty or wrongly typed value', () => {
    expect(readString({ label: 'here' }, 'label')).toBe('here');
    expect(readString({ label: '' }, 'label')).toBeNull();
    expect(readString({ label: 3 }, 'label')).toBeNull();
    expect(readString({}, 'label')).toBeNull();

    expect(readNumber({ width: 2 }, 'width')).toBe(2);
    expect(readNumber({ width: Number.NaN }, 'width')).toBeNull();
    expect(readNumber({ width: '2' }, 'width')).toBeNull();

    expect(readBoolean({ checked: true }, 'checked')).toBe(true);
    expect(readBoolean({ checked: 'true' }, 'checked')).toBe(false);
    expect(readBoolean({}, 'checked')).toBe(false);
  });
});
