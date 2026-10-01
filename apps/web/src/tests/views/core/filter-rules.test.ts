import { describe, expect, it } from 'vitest';

import type { PropertyOwner, ViewFilterRule } from '../../../views/core/container-model';
import { applyRules, evaluateRule, type RuleContext } from '../../../views/core/filter-rules';

const CONTEXT: RuleContext = { today: '2026-10-01', principalId: 'principal-me' };

function owner(properties: Record<string, unknown>): PropertyOwner {
  return { title: 'Item', properties };
}

function rule(property: string, operator: string, value = ''): ViewFilterRule {
  return { property, operator, value };
}

describe('client-side filter rules', () => {
  it('matches equals against strings, numbers, checkboxes and multi-select members', () => {
    expect(evaluateRule(owner({ status: 'Open' }), rule('status', 'equals', 'Open'), CONTEXT)).toBe(
      true,
    );
    expect(evaluateRule(owner({ points: 3 }), rule('points', 'equals', '3'), CONTEXT)).toBe(true);
    expect(evaluateRule(owner({ done: true }), rule('done', 'equals', 'true'), CONTEXT)).toBe(true);
    expect(evaluateRule(owner({ tags: ['a', 'b'] }), rule('tags', 'equals', 'b'), CONTEXT)).toBe(
      true,
    );
    expect(
      evaluateRule(owner({ status: 'Open' }), rule('status', 'equals', 'Closed'), CONTEXT),
    ).toBe(false);
  });

  it('treats an absent property as not equal, as the server does', () => {
    expect(evaluateRule(owner({}), rule('done', 'not-equals', 'true'), CONTEXT)).toBe(true);
  });

  it('resolves me to the signed-in principal, and to nobody while that is unknown', () => {
    const assigned = owner({ owner: 'principal-me' });

    expect(evaluateRule(assigned, rule('owner', 'equals', 'me'), CONTEXT)).toBe(true);
    expect(
      evaluateRule(assigned, rule('owner', 'equals', 'me'), { ...CONTEXT, principalId: null }),
    ).toBe(false);
  });

  it('compares days, resolving today and reading a timestamp by its local day', () => {
    const due = owner({ due: '2026-09-30' });
    const meeting = owner({ at: '2026-10-01T23:30:00-07:00[America/Los_Angeles]' });

    expect(evaluateRule(due, rule('due', 'before', 'today'), CONTEXT)).toBe(true);
    expect(evaluateRule(due, rule('due', 'on-or-after', 'today'), CONTEXT)).toBe(false);
    expect(evaluateRule(meeting, rule('at', 'on', '2026-10-01'), CONTEXT)).toBe(true);
  });

  it('includes both ends of within-next', () => {
    expect(
      evaluateRule(owner({ due: '2026-10-01' }), rule('due', 'within-next', '7'), CONTEXT),
    ).toBe(true);
    expect(
      evaluateRule(owner({ due: '2026-10-08' }), rule('due', 'within-next', '7'), CONTEXT),
    ).toBe(true);
    expect(
      evaluateRule(owner({ due: '2026-10-09' }), rule('due', 'within-next', '7'), CONTEXT),
    ).toBe(false);
  });

  it('compares numbers numerically and refuses a blank literal', () => {
    expect(
      evaluateRule(owner({ amount: 1.5 }), rule('amount', 'greater-than', '1.25'), CONTEXT),
    ).toBe(true);
    expect(evaluateRule(owner({ amount: -10 }), rule('amount', 'less-than', '-5'), CONTEXT)).toBe(
      true,
    );
    expect(evaluateRule(owner({ amount: 1 }), rule('amount', 'greater-than', ''), CONTEXT)).toBe(
      false,
    );
  });

  it('reads contains case-insensitively and empty as absent, blank or an empty list', () => {
    expect(
      evaluateRule(owner({ name: 'Quarterly Plan' }), rule('name', 'contains', 'plan'), CONTEXT),
    ).toBe(true);
    expect(evaluateRule(owner({ tags: [] }), rule('tags', 'is-empty'), CONTEXT)).toBe(true);
    expect(evaluateRule(owner({ name: '' }), rule('name', 'is-not-empty'), CONTEXT)).toBe(false);
  });

  it('admits everything for an operator this build does not know', () => {
    expect(evaluateRule(owner({}), rule('x', 'some-future-operator', 'v'), CONTEXT)).toBe(true);
  });

  it('ANDs rules together and returns the same array when there are none', () => {
    const items = [owner({ status: 'Open', points: 3 }), owner({ status: 'Open', points: 1 })];

    expect(applyRules(items, [], CONTEXT)).toBe(items);
    expect(
      applyRules(
        items,
        [rule('status', 'equals', 'Open'), rule('points', 'greater-than', '2')],
        CONTEXT,
      ),
    ).toEqual([items[0]]);
  });
});
