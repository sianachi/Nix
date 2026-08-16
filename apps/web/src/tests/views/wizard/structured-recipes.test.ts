import { describe, expect, it } from 'vitest';

import {
  SMART_LIST_STARTERS,
  STRUCTURED_RECIPES,
  findStructuredRecipe,
  viewForRecipe,
} from '../../../views/wizard/structured-recipes';

describe('the structured-view recipe registry', () => {
  it('defines every guided action in one registry', () => {
    expect(STRUCTURED_RECIPES.filter((recipe) => recipe.menu === 'structured')).toHaveLength(7);
    expect(STRUCTURED_RECIPES.filter((recipe) => recipe.menu === 'template')).toHaveLength(3);
    expect(STRUCTURED_RECIPES.map((recipe) => recipe.id)).toEqual([
      'board',
      'timeline',
      'gallery',
      'sheet',
      'form',
      'interactive-form',
      'query',
      'kanban',
      'calendar',
      'list',
    ]);
  });

  it.each(STRUCTURED_RECIPES)('builds a complete $id starting view', (recipe) => {
    const view = viewForRecipe(recipe, recipe.properties);

    expect(view.kind).toBe(recipe.viewKind);
    expect(view.name).toBe(recipe.defaultViewName);
    expect(view.columns).toEqual(['title', ...recipe.properties.map((property) => property.key)]);
    expect(view.companionViewId).toBeNull();
    expect(view.companionPlacement).toBeNull();
  });

  it('prefills the complete first page for an interactive form', () => {
    const recipe = findStructuredRecipe('interactive-form');
    expect(recipe).not.toBeNull();
    if (recipe === null) return;

    const form = viewForRecipe(recipe, recipe.properties).interactiveForm;
    expect(form?.pages).toHaveLength(1);
    expect(form?.pages[0]?.blocks[0]).toMatchObject({
      kind: 'field',
      propertyKey: 'response',
    });
    expect(form?.confirmationTitle).toBe('Response received');
  });

  it('keeps date shortcuts inside the Smart list wizard', () => {
    expect(SMART_LIST_STARTERS.map((starter) => starter.label)).toEqual([
      'Today',
      'Next 7 days',
      'Overdue',
    ]);
  });
});
