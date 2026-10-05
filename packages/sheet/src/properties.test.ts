import { describe, expect, it } from 'vitest';

import { parseFormula } from './parser.js';
import {
  PROPERTY_FORMULA_LIMITS,
  evaluateFormulaPlan,
  evaluatePropertyFormulas,
  formulaFieldNames,
  planPropertyFormulas,
} from './properties.js';
import { tokenize } from './tokenizer.js';
import { type CellValue } from './values.js';

function bag(values: Readonly<Record<string, CellValue>>) {
  return (key: string): CellValue | undefined =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined;
}

function evaluate(
  formulas: readonly { key: string; expression: string }[],
  values: Readonly<Record<string, CellValue>> = {},
) {
  return evaluatePropertyFormulas({ formulas, read: bag(values) });
}

describe('bracketed field references', () => {
  it('lexes a bracketed key as one field token', () => {
    const lexed = tokenize('[due date] + 1');
    expect(lexed.ok).toBe(true);
    expect(lexed.ok && lexed.tokens[0]).toEqual({ type: 'field', text: 'due date', position: 0 });
  });

  it('trims whitespace inside the brackets so a key is written either way', () => {
    const lexed = tokenize('[ estimate ]');
    expect(lexed.ok && lexed.tokens[0]?.text).toBe('estimate');
  });

  it('refuses a reference that names nothing', () => {
    expect(tokenize('[]').ok).toBe(false);
    expect(tokenize('[   ]').ok).toBe(false);
  });

  it('refuses a reference that is never closed', () => {
    expect(tokenize('[estimate').ok).toBe(false);
  });

  it('parses a field into the tree the evaluator walks', () => {
    expect(parseFormula('[a]')).toEqual({ kind: 'field', name: 'a' });
  });

  it('leaves a sheet formula parsing as the cell references it always did', () => {
    const parsed = parseFormula('SUM(A1:B2) * 2');
    expect(parsed).toMatchObject({
      kind: 'binary',
      op: '*',
      left: { kind: 'call', name: 'SUM', args: [{ kind: 'range' }] },
      right: { kind: 'number', value: 2 },
    });
  });
});

describe('evaluating a formula property', () => {
  it('computes an expression over the item own properties', () => {
    const { values } = evaluate([{ key: 'total', expression: '[price] * [quantity]' }], {
      price: 12.5,
      quantity: 4,
    });
    expect(values.get('total')).toBe(50);
  });

  it('offers the same function set the sheet body does', () => {
    const { values } = evaluate(
      [{ key: 'label', expression: 'UPPER(LEFT([name], 3)) & "-" & ROUND([score], 1)' }],
      { name: 'widget', score: 4.26 },
    );
    expect(values.get('label')).toBe('WID-4.3');
  });

  it('reads a formula property from another formula property', () => {
    const { values } = evaluate(
      [
        { key: 'remaining', expression: '[budget] - [spent]' },
        { key: 'headroom', expression: '[remaining] / [budget]' },
      ],
      { budget: 200, spent: 50 },
    );
    expect(values.get('remaining')).toBe(150);
    expect(values.get('headroom')).toBe(0.75);
  });

  it('answers a cycle with the cycle error rather than a number', () => {
    const { values } = evaluate([
      { key: 'a', expression: '[b] + 1' },
      { key: 'b', expression: '[a] + 1' },
    ]);
    expect(values.get('a')).toEqual({ error: '#CYCLE!' });
    expect(values.get('b')).toEqual({ error: '#CYCLE!' });
  });

  it('answers a self reference with the cycle error', () => {
    const { values } = evaluate([{ key: 'a', expression: '[a] + 1' }]);
    expect(values.get('a')).toEqual({ error: '#CYCLE!' });
  });

  it('carries the cycle error downstream to whatever reads a cyclic property', () => {
    const { values } = evaluate([
      { key: 'a', expression: '[b]' },
      { key: 'b', expression: '[a]' },
      { key: 'c', expression: '[a] + 1' },
    ]);
    expect(values.get('c')).toEqual({ error: '#CYCLE!' });
  });

  it('tells a misspelled key apart from an empty one', () => {
    const { values } = evaluate(
      [
        { key: 'typo', expression: '[quantitiy] + 1' },
        { key: 'empty', expression: '[quantity] + 1' },
      ],
      { quantity: null },
    );
    expect(values.get('typo')).toEqual({ error: '#NAME?' });
    expect(values.get('empty')).toBe(1);
  });

  it('reports an expression it cannot parse rather than guessing', () => {
    const { values } = evaluate([{ key: 'broken', expression: '[a] +' }]);
    expect(values.get('broken')).toEqual({ error: '#PARSE!' });
  });

  it('divides by zero the way the sheet does', () => {
    const { values } = evaluate([{ key: 'rate', expression: '[done] / [total]' }], {
      done: 3,
      total: 0,
    });
    expect(values.get('rate')).toEqual({ error: '#DIV/0!' });
  });

  it('has no cells to read, so an A1 in a property formula refers to nothing', () => {
    const { values } = evaluate([{ key: 'stray', expression: 'A1 + 1' }]);
    expect(values.get('stray')).toEqual({ error: '#REF!' });
  });

  it('bounds an expression by length rather than trying it', () => {
    const long = '1 + '.repeat(PROPERTY_FORMULA_LIMITS.maxLength) + '1';
    const { values } = evaluate([{ key: 'long', expression: long }]);
    expect(values.get('long')).toEqual({ error: '#LIMIT!' });
  });

  it('lets one over-long formula report a limit without taking the others down with it', () => {
    const long = '1 + '.repeat(PROPERTY_FORMULA_LIMITS.maxLength) + '1';
    const { values } = evaluate(
      [
        { key: 'long', expression: long },
        { key: 'fine', expression: '[a] + 1' },
      ],
      { a: 1 },
    );

    expect(values.get('long')).toEqual({ error: '#LIMIT!' });
    expect(values.get('fine')).toBe(2);
  });

  it('does not let a schema of many ordinary formulas exhaust one item budget by their length', () => {
    // The regression this guards: parsing used to be charged to the per-item budget, so once the
    // *sum* of a schema's expression lengths passed the ceiling every formula in it read #LIMIT!.
    // Twenty columns averaging 270 characters was enough, and Core stored such a schema happily -
    // it checks each expression's length and never their total.
    const padding = ' + 0'.repeat(64);
    const formulas = Array.from({ length: 20 }, (_, index) => ({
      key: `f${String(index)}`,
      expression: `[a]${padding}`,
    }));
    expect(formulas.reduce((total, f) => total + f.expression.length, 0)).toBeGreaterThan(
      PROPERTY_FORMULA_LIMITS.maxOps,
    );

    const { values } = evaluate(formulas, { a: 7 });

    expect([...values.values()]).not.toContainEqual({ error: '#LIMIT!' });
    expect(values.get('f0')).toBe(7);
    expect(values.get('f19')).toBe(7);
  });

  it('spends a bounded budget however involved one item evaluation gets', () => {
    const formulas = Array.from({ length: 600 }, (_, index) => ({
      key: `f${String(index)}`,
      expression: 'SUM(1,2,3,4,5,6,7,8,9,10) * 2 + LEN("abcdefghij")',
    }));
    const { opsUsed, exceeded, values } = evaluate(formulas);

    // Bounded, not capped to the ceiling exactly: `charge` adds before it refuses, so the last
    // charge admitted may carry the total past by its own size.
    expect(opsUsed).toBeLessThanOrEqual(PROPERTY_FORMULA_LIMITS.maxOps + 16);
    expect(exceeded).toBe(true);
    // Every declared property still answers: what the budget cut off says so.
    expect(values.size).toBe(600);
    expect([...values.values()]).toContainEqual({ error: '#LIMIT!' });
  });

  it('costs nothing when an item declares no formulas', () => {
    const evaluation = evaluate([]);
    expect(evaluation.opsUsed).toBe(0);
    expect(evaluation.values.size).toBe(0);
  });
});

describe('reading the keys an expression depends on', () => {
  it('lists each referenced key once, in the order it appears', () => {
    expect(formulaFieldNames('[b] + [a] * [b]')).toEqual(['b', 'a']);
  });

  it('reaches into function arguments', () => {
    expect(formulaFieldNames('IF([done], [hours], 0)')).toEqual(['done', 'hours']);
  });

  it('answers null for an expression that does not parse, rather than an empty list', () => {
    expect(formulaFieldNames('[a] +')).toBeNull();
  });
});

describe('planning a schema once and evaluating many items against it', () => {
  it('gives every item the value it would have got on its own', () => {
    const formulas = [
      { key: 'remaining', expression: '[budget] - [spent]' },
      { key: 'headroom', expression: '[remaining] / [budget]' },
    ];
    const plan = planPropertyFormulas(formulas);

    for (const [budget, spent, remaining, headroom] of [
      [200, 50, 150, 0.75],
      [80, 80, 0, 0],
      [10, 2, 8, 0.8],
    ] as const) {
      const planned = evaluateFormulaPlan(plan, bag({ budget, spent }));
      const alone = evaluate(formulas, { budget, spent });

      expect(planned.values.get('remaining')).toBe(remaining);
      expect(planned.values.get('headroom')).toBe(headroom);
      expect([...planned.values]).toEqual([...alone.values]);
    }
  });

  it('settles a cycle once rather than per item', () => {
    const plan = planPropertyFormulas([
      { key: 'a', expression: '[b]' },
      { key: 'b', expression: '[a]' },
    ]);

    expect(plan.fixed.get('a')).toEqual({ error: '#CYCLE!' });
    expect(plan.order).toEqual([]);
    expect(evaluateFormulaPlan(plan, bag({})).values.get('b')).toEqual({ error: '#CYCLE!' });
  });

  it('gives each item its own budget rather than a shared one', () => {
    // The whole point of the split: one item's expensive evaluation must not leave the next item
    // reporting a limit it never reached.
    const plan = planPropertyFormulas([{ key: 'n', expression: 'SUM(1,2,3) + 1' }]);

    for (let index = 0; index < 1_000; index += 1) {
      expect(evaluateFormulaPlan(plan, bag({})).values.get('n')).toBe(7);
    }
  });

  it('costs nothing to plan a schema with no formulas', () => {
    const plan = planPropertyFormulas([]);
    expect(plan.keys).toEqual([]);
    expect(evaluateFormulaPlan(plan, bag({})).opsUsed).toBe(0);
  });
});
