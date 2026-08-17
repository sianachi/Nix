import { describe, expect, it } from 'vitest';

import {
  normalizeInteractiveForm,
  validateInteractiveForm,
} from '../../../views/form/interactive-form-rules';
import type {
  InteractiveFormDefinition,
  PropertyDefinition,
} from '../../../views/core/container-model';

const SCHEMA: readonly PropertyDefinition[] = [
  { key: 'name', label: 'Name', type: 'text', options: [], required: false },
  { key: 'mood', label: 'Mood', type: 'select', options: ['Good', 'Hard'], required: false },
];

function form(): InteractiveFormDefinition {
  return {
    pages: [
      {
        id: 'first',
        title: 'First',
        description: null,
        visibleWhen: [],
        blocks: [
          {
            id: 'name-field',
            kind: 'field',
            propertyKey: 'name',
            text: 'Your name',
            help: null,
            required: true,
            identityRole: 'name',
            visibleWhen: [],
          },
          {
            id: 'mood-field',
            kind: 'field',
            propertyKey: 'mood',
            text: 'How are you?',
            help: null,
            required: true,
            identityRole: null,
            visibleWhen: [{ fieldBlockId: 'name-field', operator: 'not_equals', value: '' }],
          },
        ],
      },
    ],
    titleMode: 'field',
    titleFieldBlockId: 'name-field',
    confirmationTitle: 'Thank you',
    confirmationMessage: 'Saved.',
  };
}

describe('interactive form authoring rules', () => {
  it('prunes a condition when moving its dependency after the conditioned field', () => {
    const current = form();
    const first = current.pages[0];
    if (first === undefined) throw new Error('The fixture needs a page.');
    const moved = {
      ...current,
      pages: [{ ...first, blocks: [...first.blocks].reverse() }],
    };

    const normalized = normalizeInteractiveForm(moved, SCHEMA);

    expect(normalized.pages[0]?.blocks[0]?.visibleWhen).toEqual([]);
    expect(validateInteractiveForm(normalized, SCHEMA)).toBeNull();
  });

  it('clears a response title and dependent conditions when its field is removed', () => {
    const current = form();
    const first = current.pages[0];
    if (first === undefined) throw new Error('The fixture needs a page.');
    const withoutName = {
      ...current,
      pages: [{ ...first, blocks: first.blocks.slice(1) }],
    };

    const normalized = normalizeInteractiveForm(withoutName, SCHEMA);

    expect(normalized.titleMode).toBe('generated');
    expect(normalized.titleFieldBlockId).toBeNull();
    expect(normalized.pages[0]?.blocks[0]?.visibleWhen).toEqual([]);
  });

  it('refuses empty pages and fields that do not map to declared schema', () => {
    const empty = form();
    const firstPage = empty.pages[0];
    const firstBlock = firstPage?.blocks[0];
    if (firstPage === undefined || firstBlock === undefined) {
      throw new Error('The fixture needs a page with a block.');
    }
    expect(
      validateInteractiveForm({ ...empty, pages: [{ ...firstPage, blocks: [] }] }, SCHEMA),
    ).toMatch(/at least one block/i);
    expect(
      validateInteractiveForm(
        {
          ...empty,
          pages: [
            {
              ...firstPage,
              blocks: [{ ...firstBlock, propertyKey: 'missing' }],
            },
          ],
        },
        SCHEMA,
      ),
    ).toMatch(/must use one of this item’s fields/i);
  });
});
