import { describe, expect, it } from 'vitest';

import type { Blueprint } from '../blueprint/schema.js';
import type { ValidationReport } from '../validate/report.js';
import { describeBlueprint } from './blueprint.js';

describe('describeBlueprint', () => {
  it('describeBlueprint headline lists the destination and counts', () => {
    const blueprint: Blueprint = {
      version: 1,
      title: 'Reading log',
      summary: 'Track books and ratings.',
      root: {
        id: 'root',
        title: 'Reading log',
        fields: [{ label: 'Rating', type: 'number' }],
        views: [{ kind: 'board', groupBy: 'rating' }],
        children: [{ id: 'book', title: 'Dune', sample: true }],
      },
    };
    const report: ValidationReport = {
      ok: true,
      problems: [],
      warnings: [],
      stats: { fields: 1, views: 1, entries: 1 },
    };
    const preview = describeBlueprint(blueprint, report, {
      destination: { title: 'Books', path: ['Books'] },
    });

    expect(preview.headline).toContain('in Books');
    expect(preview.headline).toContain('2 items, 1 field, 1 view and 1 example');
    expect(preview.tree[0]?.label).toBe('Track books and ratings.');
    expect(preview.tree[1]?.detail).toContain('Rating (number)');
    expect(preview.tree[1]?.detail).toContain('Board grouped by Rating');
    expect(preview.tree[1]?.children[0]?.label).toBe('Example: Dune');
    expect(preview.notes).toContain('Creates a draft in Books. Nothing is published.');
  });
});
