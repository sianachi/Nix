import { describe, expect, it } from 'vitest';
import { boundedStructureRead, MAX_STRUCTURE_READ_TEXT } from './read-output.js';

describe('bounded structure evidence output', () => {
  it('keeps small complete reads unchanged', () => {
    const value = { item: { id: 'item' }, views: [], childCount: 0 };
    expect(boundedStructureRead('read_structure', value)).toBe(JSON.stringify(value));
  });

  it('preserves conditional form outline and source limits when long block text is shortened', () => {
    const value = {
      item: { id: 'item', title: 'Intake' },
      view: {
        id: 'form',
        name: 'Intake',
        kind: 'interactive_form',
        canRender: true,
        isDefault: true,
        interactiveForm: {
          pages: [
            {
              id: 'page',
              title: 'Details',
              visibleWhen: [],
              blocks: [
                {
                  id: 'question',
                  kind: 'field',
                  propertyKey: 'due',
                  text: 'x'.repeat(50000),
                  visibleWhen: [{ fieldBlockId: 'category', operator: 'equals', value: 'Work' }],
                  required: true,
                },
              ],
            },
          ],
        },
      },
      source: 'workspace_query',
      totalCount: 100,
      returned: 1,
      truncated: false,
      appliedViewRules: true,
      nextCursor: null,
      limits: ['Dates are a sample.'],
      results: [{ id: 'row', title: 'Example', properties: { due: '2026-10-09' } }],
    };
    const text = boundedStructureRead('read_view', value);
    const result = JSON.parse(text) as typeof value & { configurationTruncated: boolean };
    expect(text.length).toBeLessThanOrEqual(MAX_STRUCTURE_READ_TEXT);
    expect(result).toMatchObject({
      source: 'workspace_query',
      totalCount: 100,
      truncated: true,
      configurationTruncated: true,
      view: { id: 'form', canRender: true },
    });
    expect(result.view.interactiveForm.pages[0]?.blocks[0]).toMatchObject({
      id: 'question',
      propertyKey: 'due',
      visibleWhen: [{ value: 'Work' }],
    });
    expect(result.limits).toContain('Dates are a sample.');
    expect(result.results[0]?.id).toBe('row');
  });

  it('keeps field types, all view identities, default and Core renderability in oversized structure', () => {
    const value = {
      item: { id: 'item' },
      defaultView: 'view0',
      hideDocument: true,
      childCount: 'many',
      viewCapacity: { limit: 12, current: 12, remaining: 0 },
      fields: Array.from({ length: 75 }, (_, i) => ({
        key: `f${String(i)}`,
        type: 'select',
        options: Array.from({ length: 50 }, () => 'v'.repeat(400)),
        inherited: false,
      })),
      views: Array.from({ length: 12 }, (_, i) => ({
        id: `view${String(i)}`,
        name: `View ${String(i)}`,
        kind: 'list',
        canRender: i !== 1,
        isDefault: i === 0,
        columns: ['f0'],
      })),
    };
    const text = boundedStructureRead('read_structure', value);
    const result = JSON.parse(text) as typeof value & { truncated: boolean; limits: string[] };
    expect(text.length).toBeLessThanOrEqual(MAX_STRUCTURE_READ_TEXT);
    expect(result.viewCapacity).toEqual(value.viewCapacity);
    expect(result.views).toHaveLength(12);
    expect(result.views[1]).toMatchObject({ id: 'view1', canRender: false });
    expect(result.fields[0]).toMatchObject({ key: 'f0', type: 'select' });
    expect(result).toMatchObject({ defaultView: 'view0', hideDocument: true, truncated: true });
  });

  it('bounds oversized property bags and counts the rows actually returned in the partial output', () => {
    const value = {
      item: { id: 'item' },
      view: { id: 'view', kind: 'list', canRender: true },
      source: 'workspace_query',
      totalCount: 250,
      returned: 25,
      nextCursor: null,
      hasUnboundedProvenance: true,
      limits: [],
      results: Array.from({ length: 25 }, (_, i) => ({
        id: `row${String(i)}`,
        properties: Object.fromEntries(
          Array.from({ length: 50 }, (_, j) => [`key${String(j)}`, 'v'.repeat(1000)]),
        ),
      })),
    };
    const text = boundedStructureRead('read_view', value);
    const result = JSON.parse(text) as typeof value & { configurationTruncated: boolean };
    expect(text.length).toBeLessThanOrEqual(MAX_STRUCTURE_READ_TEXT);
    expect(result.totalCount).toBe(250);
    expect(result.returned).toBe(result.results.length);
    expect(result.hasUnboundedProvenance).toBe(true);
    expect(result.configurationTruncated).toBe(true);
  });
  it('never clips identifiers or field types, including the final wide-schema summary', () => {
    const viewId = 'v'.repeat(128);
    const key = 'k'.repeat(128);
    const type = 't'.repeat(128);
    const value = {
      item: { id: 'item' },
      defaultView: viewId,
      views: Array.from({ length: 12 }, () => ({
        id: viewId,
        name: 'A view',
        kind: 'list',
        canRender: true,
      })),
      fields: Array.from({ length: 100 }, () => ({
        key,
        type,
        required: true,
        options: ['o'.repeat(10000)],
      })),
    };
    const text = boundedStructureRead('read_structure', value);
    const result = JSON.parse(text) as typeof value & { configurationTruncated: boolean };
    expect(text.length).toBeLessThanOrEqual(MAX_STRUCTURE_READ_TEXT);
    expect(result.defaultView).toBe(viewId);
    expect(result.views).toHaveLength(12);
    expect(result.views[0]?.id).toBe(viewId);
    expect(result.fields[0]).toMatchObject({ key, type });
    expect(result.fields.length).toBeLessThan(100);
    expect(result.configurationTruncated).toBe(true);
  });
});
