import { describe, expect, it } from 'vitest';

import {
  defaultInteractiveForm,
  keyForProperty,
  STRUCTURED_RECIPES,
  viewForRecipe,
} from './recipes.js';

describe('keyForProperty', () => {
  it('lowercases and underscores a label', () => {
    expect(keyForProperty('Finished on')).toBe('finished_on');
  });

  it('falls back to "field" for a label with no letters or digits', () => {
    expect(keyForProperty('  ')).toBe('field');
  });

  it('strips characters other than letters, digits and separators', () => {
    expect(keyForProperty('Rating (1-5)')).toBe('rating_1_5');
  });
});

describe('viewForRecipe', () => {
  it.each(STRUCTURED_RECIPES.map((recipe) => [recipe.id, recipe] as const))(
    'produces the documented view id for %s',
    (_id, recipe) => {
      const view = viewForRecipe(recipe, recipe.properties);
      const expectedId = recipe.viewKind === 'interactive_form' ? 'form' : recipe.viewKind;
      expect(view.id).toBe(expectedId);
      expect(view.kind).toBe(recipe.viewKind);
    },
  );
});

describe('defaultInteractiveForm', () => {
  it('has one page, one field block, and a generated title', () => {
    const form = defaultInteractiveForm();
    expect(form.pages).toHaveLength(1);
    expect(form.pages[0]?.blocks).toHaveLength(1);
    expect(form.pages[0]?.blocks[0]?.kind).toBe('field');
    expect(form.titleMode).toBe('generated');
  });
});
