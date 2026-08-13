import { describe, expect, it } from 'vitest';

import { LOSS_KINDS, createLossReport } from './loss.js';

describe('the loss report', () => {
  it('is empty until something is noted', () => {
    const report = createLossReport();

    expect(report.isEmpty()).toBe(true);
    expect(report.entries()).toEqual([]);
  });

  it('folds repeats of one kind into a single entry carrying the count', () => {
    const report = createLossReport();
    const sink = report.for('item-a');

    sink.note('comment-dropped', 'A comment was not carried over.');
    sink.note('comment-dropped', 'A comment was not carried over.');
    sink.note('comment-dropped', 'A comment was not carried over.');

    expect(report.entries()).toEqual([
      {
        itemId: 'item-a',
        kind: 'comment-dropped',
        detail: 'A comment was not carried over. This happened 3 times.',
      },
    ]);
  });

  it('folds sinks taken separately for one item, so a per-node sink does not fragment it', () => {
    const report = createLossReport();

    report.for('item-a').note('comment-dropped', 'A comment was not carried over.');
    report.for('item-a').note('comment-dropped', 'A comment was not carried over.');

    expect(report.entries()).toHaveLength(1);
    expect(report.entries()[0]?.detail).toContain('2 times');
  });

  it('keeps one entry per item, so a subtree names which document lost what', () => {
    const report = createLossReport();

    report.for('item-a').note('comment-dropped', 'A comment was not carried over.');
    report.for('item-b').note('comment-dropped', 'A comment was not carried over.');

    expect(report.entries().map((entry) => entry.itemId)).toEqual(['item-a', 'item-b']);
  });

  it('reads in the order the losses were first seen', () => {
    const report = createLossReport();
    const sink = report.for('item-a');

    sink.note('image-not-embedded', 'An image was not embedded.');
    sink.note('comment-dropped', 'A comment was not carried over.');
    sink.note('image-not-embedded', 'An image was not embedded.');

    expect(report.entries().map((entry) => entry.kind)).toEqual([
      'image-not-embedded',
      'comment-dropped',
    ]);
  });

  it('reports the kinds observed, which is what the honesty test compares against', () => {
    const report = createLossReport();

    report.for('item-a').note('reference-flattened', 'A link to another item became its label.');
    report.for('item-b').note('reference-flattened', 'A link to another item became its label.');

    expect([...report.kinds()]).toEqual(['reference-flattened']);
    expect(report.isEmpty()).toBe(false);
  });

  it('holds no duplicate kinds, because a report nobody can aggregate is not a report', () => {
    expect([...new Set(LOSS_KINDS)]).toHaveLength(LOSS_KINDS.length);
  });
});
