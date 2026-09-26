import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FORMULA_FUNCTION_NAMES } from '@nix/sheet';
import { describe, expect, it } from 'vitest';

import { buildCatalog, renderChat, renderConsult } from './build.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..', '..');

function readPatterns(): string {
  return readFileSync(resolve(packageRoot, 'catalog/patterns.txt'), 'utf8');
}

describe('the capability catalog', () => {
  it('renders chat text at most 3000 chars and consult text at most 12000 chars', () => {
    const catalog = buildCatalog();
    const chat = renderChat(catalog);
    const consult = renderConsult(catalog, readPatterns());
    expect(chat.length).toBeLessThanOrEqual(3000);
    expect(consult.length).toBeLessThanOrEqual(12000);
  });

  it('names every property type in PROPERTY_TYPES except assignee', () => {
    const catalog = buildCatalog();
    const names = catalog.propertyTypes.map((type) => type.type);
    expect(names).not.toContain('assignee');
    // The full type list, minus assignee, as PROPERTY_TYPES declares it (property-types.ts).
    expect(names).toEqual([
      'text',
      'number',
      'select',
      'multi_select',
      'date',
      'timestamp',
      'checkbox',
      'url',
      'image',
      'due_date',
      'start_date',
      'completion',
      'priority',
      'estimate',
      'formula',
      'rollup',
    ]);
  });

  it('lists IF among the formula functions', () => {
    const catalog = buildCatalog();
    expect(catalog.formulaFunctions).toContain('IF');
    // The catalog's formula function names are exactly @nix/sheet's own list - not a hand-copy
    // that could grow, shrink or duplicate independently of what a formula can actually call.
    expect(catalog.formulaFunctions).toEqual(FORMULA_FUNCTION_NAMES);
    expect(new Set(catalog.formulaFunctions).size).toBe(catalog.formulaFunctions.length);
  });

  it('never offers the assignee property type or the drive and finances recipes', () => {
    const catalog = buildCatalog();
    const propertyTypes = catalog.propertyTypes.map((type) => type.type);
    const recipeIds = catalog.recipes.map((recipe) => recipe.id);
    const recipeViewKinds = catalog.recipes.map((recipe) => recipe.viewKind);

    expect(propertyTypes).not.toContain('assignee');
    expect(recipeIds).not.toContain('drive');
    expect(recipeIds).not.toContain('finances');
    expect(recipeViewKinds).not.toContain('drive');
    expect(recipeViewKinds).not.toContain('finance');
  });

  it('names only known field types, view kinds and operators in patterns.txt', () => {
    const catalog = buildCatalog();
    const knownFieldTypes = new Set(catalog.propertyTypes.map((type) => type.type));
    const knownViewKinds = new Set(catalog.viewKinds.map((kind) => kind.kind));
    const knownOperators = new Set(catalog.queryOperators.map((operator) => operator.op));

    const patterns = readPatterns();
    const backticked = [...patterns.matchAll(/`([^`]+)`/g)].map((match) => {
      const token = match[1];
      if (token === undefined) {
        throw new Error('a backtick regex match unexpectedly captured nothing');
      }
      return token;
    });
    expect(backticked.length).toBeGreaterThan(0);

    for (const token of backticked) {
      const known =
        knownFieldTypes.has(token) || knownViewKinds.has(token) || knownOperators.has(token);
      expect(known, `'${token}' is not a known field type, view kind or operator`).toBe(true);
    }
  });

  it('matches a fresh build to the committed generated catalog.json', () => {
    const committed = JSON.parse(
      readFileSync(resolve(packageRoot, 'src/generated/catalog.json'), 'utf8'),
    ) as unknown;
    const fresh = JSON.parse(JSON.stringify(buildCatalog())) as unknown;
    expect(committed, 'run: pnpm --filter @nix/structure-spec catalog').toEqual(fresh);
  });
});
