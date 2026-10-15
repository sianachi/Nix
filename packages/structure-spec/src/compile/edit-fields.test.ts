import { describe, expect, it } from 'vitest';
import { compileEditFields } from './edits.js';
import { fieldsSpecSchema } from '../spec/edits.js';
import { validateSpec } from '../validate/spec.js';
import { describeSteps } from '../describe/steps.js';
import { viewForRecipe, findStructuredRecipe } from '../vocabulary/recipes.js';

const who = { key: 'who', label: 'Who', type: 'text', options: [], required: false };
const reason = { key: 'reason', label: 'Reason', type: 'text', options: [], required: true };
const existing = { declared: [who, reason], effective: [who, reason], inherit: true, views: [] };
const context = { existing, inheritedFields: [], today: '2026-10-15' };
const spec = fieldsSpecSchema.parse({
  fields: [{ key: 'who', label: 'Who offended you', type: 'multi_select', choiceSource: {} }],
});

describe('explicit field edits', () => {
  it('retypes only the named field, preserving unrelated declarations and inheritance', () => {
    expect(validateSpec('edit_fields', spec, context).ok).toBe(true);
    const steps = compileEditFields(spec, { itemId: 'grudges', existing });
    expect(steps).toEqual([
      {
        kind: 'setItemSchema',
        itemId: 'grudges',
        changes: [
          {
            ...who,
            label: 'Who offended you',
            type: 'multi_select',
            choiceSource: { itemId: null, field: 'who' },
            expression: null,
            aggregate: null,
            source: null,
          },
        ],
        schema: {
          inherit: true,
          properties: [
            {
              ...who,
              label: 'Who offended you',
              type: 'multi_select',
              choiceSource: { itemId: null, field: 'who' },
              expression: null,
              aggregate: null,
              source: null,
            },
            reason,
          ],
        },
      },
    ]);
    const preview = describeSteps(steps, {
      destination: { title: 'Grudges', path: [] },
      existing,
      warnings: [],
      problems: [],
    });
    expect(preview.tree[0]?.detail).toEqual([
      'Who offended you: text to multi_select; suggestions from this note.who',
    ]);
    expect(preview.notes.join(' ')).toContain('retained without conversion');
    expect(preview.tree[0]?.children[0]?.detail[1]).toContain('suggestions this note, field who');
    expect(preview.tree[0]?.children[0]?.detail[0]).toContain('required no');
  });

  it('refuses new keys and inherited fields', () => {
    expect(
      validateSpec(
        'edit_fields',
        { fields: [{ key: 'missing', label: 'Missing', type: 'text' }] },
        context,
      ).ok,
    ).toBe(false);
    expect(
      validateSpec('edit_fields', spec, {
        ...context,
        existing: { ...existing, declared: [reason] },
        inheritedFields: [who],
      }).ok,
    ).toBe(false);
  });

  it('refuses a type change that breaks an existing board', () => {
    const recipe = findStructuredRecipe('board');
    if (!recipe) throw new Error('Missing board recipe');
    const status = { ...who, type: 'select', options: ['Alex'] };
    const board = { ...viewForRecipe(recipe, [status]), groupBy: 'who' };
    expect(
      validateSpec('edit_fields', spec, {
        ...context,
        existing: { ...existing, declared: [status], views: [board] },
      }).ok,
    ).toBe(false);
  });

  it('leaves add_fields additive', () => {
    expect(validateSpec('add_fields', spec, context).ok).toBe(false);
  });
});
