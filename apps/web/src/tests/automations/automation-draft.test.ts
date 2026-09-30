import type { AutomationRuleResponse as AutomationRule } from '@nix/api-client';
import { describe, expect, it } from 'vitest';

import {
  describeRunReason,
  describeRunStatus,
  draftFromRule,
  emptyDraft,
  parseViolations,
  ruleInputFromDraft,
  summarizeTrigger,
  validateDraft,
  type AutomationDraft,
} from '../../automations/automation-draft';

const SCOPE = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';

function storedRule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    workspaceId: '00000000-0000-4000-8000-000000000001',
    name: 'Chase overdue',
    enabled: true,
    scopeItemId: SCOPE,
    trigger: { type: 'date_arrives', key: 'due_date', offsetMinutes: -2880, time: '08:00' },
    conditions: [{ key: 'status', op: 'not_equals', value: 'Done' }],
    actions: [
      { type: 'set_property', target: 'triggering_item', key: 'priority', value: 1 },
      { type: 'notify', title: '{item.title} is due soon', body: 'Due {date}' },
    ],
    revision: 3,
    consecutiveFailures: 0,
    disabledReason: null,
    lastRunAt: null,
    createdAt: '2026-09-30T09:00:00+00:00',
    updatedAt: '2026-09-30T09:00:00+00:00',
    ...overrides,
  };
}

function scheduleDraft(): AutomationDraft {
  const draft = emptyDraft(null);
  return {
    ...draft,
    name: 'Weekly review',
    triggerKind: 'schedule',
    schedule: { ...draft.schedule, freq: 'weekly', weekdays: ['fr'], time: '16:00' },
    actions: [{ kind: 'notify', title: 'Weekly review', body: '' }],
  };
}

describe('building a rule document from the editor draft', () => {
  it('writes a weekly schedule with only the members Core reads', () => {
    expect(ruleInputFromDraft(scheduleDraft())).toEqual({
      name: 'Weekly review',
      enabled: true,
      scopeItemId: null,
      trigger: { type: 'schedule', freq: 'weekly', interval: 1, weekdays: ['fr'], time: '16:00' },
      conditions: [],
      actions: [{ type: 'notify', title: 'Weekly review', body: '' }],
    });
  });

  it('leaves weekdays out of a daily schedule and names a chosen zone', () => {
    const draft = scheduleDraft();
    const input = ruleInputFromDraft({
      ...draft,
      schedule: { ...draft.schedule, freq: 'daily', timeZone: 'Europe/London' },
    });
    expect(input.trigger).toEqual({
      type: 'schedule',
      freq: 'daily',
      interval: 1,
      time: '16:00',
      timeZone: 'Europe/London',
    });
  });

  it('turns a date offset in days before into negative minutes', () => {
    const draft = emptyDraft(SCOPE);
    const input = ruleInputFromDraft({
      ...draft,
      name: 'Due soon',
      triggerKind: 'date_arrives',
      date: { key: 'due_date', amount: '2', unit: 'days', direction: 'before', time: '08:00' },
      actions: [{ kind: 'notify', title: 'Due soon', body: '' }],
    });
    expect(input.trigger).toEqual({
      type: 'date_arrives',
      key: 'due_date',
      offsetMinutes: -2880,
      time: '08:00',
    });
  });

  it('writes a property change with an optional to value typed by the property', () => {
    const draft = emptyDraft(SCOPE);
    const input = ruleInputFromDraft({
      ...draft,
      name: 'On done',
      triggerKind: 'property_changed',
      property: {
        key: 'completion',
        from: { mode: 'any', value: { type: 'text', text: '' } },
        to: { mode: 'value', value: { type: 'boolean', text: 'true' } },
      },
      actions: [{ kind: 'notify', title: 'Done', body: '' }],
    });
    expect(input.trigger).toEqual({
      type: 'property_changed',
      key: 'completion',
      to: { value: true },
    });
  });

  it('writes an explicit clear as a null value, not as an absent one', () => {
    const draft = emptyDraft(SCOPE);
    const input = ruleInputFromDraft({
      ...draft,
      name: 'Cleared',
      triggerKind: 'property_changed',
      property: {
        key: 'status',
        from: { mode: 'empty', value: { type: 'text', text: '' } },
        to: { mode: 'any', value: { type: 'text', text: '' } },
      },
      actions: [
        {
          kind: 'set_property',
          target: 'triggering_item',
          targetItemId: null,
          key: 'owner',
          clear: true,
          value: { type: 'text', text: '' },
        },
      ],
    });
    expect(input.trigger).toEqual({
      type: 'property_changed',
      key: 'status',
      from: { value: null },
    });
    expect(input.actions).toEqual([
      { type: 'set_property', target: 'triggering_item', key: 'owner', value: null },
    ]);
  });

  it('writes item references as Core spells them', () => {
    const draft = emptyDraft(SCOPE);
    const input = ruleInputFromDraft({
      ...draft,
      name: 'Log it',
      triggerKind: 'property_changed',
      property: { ...draft.property, key: 'status' },
      actions: [
        {
          kind: 'create_item',
          parent: 'item',
          parentItemId: TARGET,
          itemType: 'note',
          title: 'Log {date}',
          properties: null,
        },
        {
          kind: 'set_property',
          target: 'item',
          targetItemId: TARGET,
          key: 'count',
          clear: false,
          value: { type: 'number', text: '4' },
        },
      ],
    });
    expect(input.actions).toEqual([
      { type: 'create_item', parent: { itemId: TARGET }, itemType: 'note', title: 'Log {date}' },
      { type: 'set_property', target: { itemId: TARGET }, key: 'count', value: 4 },
    ]);
  });
});

describe('reading a stored rule into the editor', () => {
  it('round-trips a rule this build can edit', () => {
    const rule = storedRule();
    const draft = draftFromRule(rule);
    expect(draft).not.toBeNull();
    if (draft === null) return;
    expect(draft.date).toEqual({
      key: 'due_date',
      amount: '2',
      unit: 'days',
      direction: 'before',
      time: '08:00',
    });
    expect(ruleInputFromDraft(draft)).toEqual({
      name: rule.name,
      enabled: true,
      scopeItemId: SCOPE,
      trigger: rule.trigger,
      conditions: rule.conditions,
      actions: rule.actions,
    });
  });

  it('keeps a schedule’s stored start date so saving does not move the anchor', () => {
    const draft = draftFromRule(
      storedRule({
        scopeItemId: null,
        trigger: {
          type: 'schedule',
          freq: 'monthly',
          interval: 1,
          time: '09:00',
          startDate: '2026-01-31',
        },
        conditions: [],
        actions: [{ type: 'notify', title: 'Pay rent', body: '' }],
      }),
    );
    expect(draft).not.toBeNull();
    if (draft === null) return;
    expect(ruleInputFromDraft(draft).trigger).toMatchObject({ startDate: '2026-01-31' });
  });

  it('refuses a rule whose trigger or action a newer build wrote', () => {
    expect(draftFromRule(storedRule({ trigger: { type: 'webhook' } }))).toBeNull();
    expect(draftFromRule(storedRule({ actions: [{ type: 'create_from_template' }] }))).toBeNull();
  });
});

describe('checking a draft before it is sent', () => {
  it('reports each problem at the path Core would name', () => {
    const draft = emptyDraft(null);
    const errors = validateDraft({
      ...draft,
      triggerKind: 'schedule',
      schedule: { ...draft.schedule, freq: 'weekly', weekdays: [], time: '' },
      actions: [],
    });
    expect(Object.keys(errors)).toEqual(
      expect.arrayContaining(['name', 'trigger.time', 'trigger.weekdays', 'actions']),
    );
  });

  it('refuses conditions and the triggering item on a schedule rule', () => {
    const draft = scheduleDraft();
    const errors = validateDraft({
      ...draft,
      conditions: [{ key: 'status', op: 'is_empty', value: { type: 'text', text: '' } }],
      actions: [
        {
          kind: 'set_property',
          target: 'triggering_item',
          targetItemId: null,
          key: 'status',
          clear: false,
          value: { type: 'text', text: 'Open' },
        },
      ],
    });
    expect(errors.conditions).toBeDefined();
    expect(errors['actions[0].target']).toBeDefined();
  });

  it('asks for a scope before a new item may be created under it', () => {
    const draft = scheduleDraft();
    const errors = validateDraft({
      ...draft,
      actions: [
        {
          kind: 'create_item',
          parent: 'scope',
          parentItemId: null,
          itemType: 'note',
          title: 'x',
          properties: null,
        },
      ],
    });
    expect(errors['actions[0].parent']).toBeDefined();
  });

  it('refuses system property keys and non-numbers in a number value', () => {
    const draft = emptyDraft(SCOPE);
    const errors = validateDraft({
      ...draft,
      name: 'x',
      triggerKind: 'property_changed',
      property: { ...draft.property, key: '$due_set_by' },
      actions: [
        {
          kind: 'set_property',
          target: 'triggering_item',
          targetItemId: null,
          key: 'count',
          clear: false,
          value: { type: 'number', text: 'many' },
        },
      ],
    });
    expect(errors['trigger.key']).toBeDefined();
    expect(errors['actions[0].value']).toBeDefined();
  });

  it('accepts a complete draft', () => {
    expect(validateDraft(scheduleDraft())).toEqual({});
  });
});

describe('reading Core’s refusals', () => {
  it('splits the invalid problem’s detail into paths and reasons', () => {
    expect(
      parseViolations('trigger.time: must be an HH:mm time; actions[1].key: must be a string'),
    ).toEqual([
      { path: 'trigger.time', reason: 'must be an HH:mm time' },
      { path: 'actions[1].key', reason: 'must be a string' },
    ]);
  });

  it('keeps a detail with no path as one general reason', () => {
    expect(parseViolations('The automation did not run: item_required.')).toEqual([
      { path: null, reason: 'The automation did not run: item_required.' },
    ]);
  });
});

describe('describing runs in words', () => {
  it('names the statuses and reasons it knows', () => {
    expect(describeRunStatus('succeeded')).toBe('Ran');
    expect(describeRunStatus('throttled')).toBe('Throttled');
    expect(describeRunReason('conditions_unmet')).toBe('The conditions were not met.');
    expect(describeRunReason('chain_depth')).toMatch(/chain/i);
  });

  it('falls back to the code for a reason this build has never seen', () => {
    expect(describeRunReason('scope_locked')).toMatch(/locked/i);
    expect(describeRunReason('something.new')).toBe('Stopped with reason code something.new.');
    expect(describeRunStatus('paused')).toBe('Paused');
  });
});

describe('summarising a trigger', () => {
  it('reads as a sentence', () => {
    expect(
      summarizeTrigger({
        type: 'schedule',
        freq: 'weekly',
        interval: 1,
        weekdays: ['mo', 'fr'],
        time: '09:00',
      }),
    ).toBe('Every week on Monday and Friday at 09:00');
    expect(summarizeTrigger({ type: 'date_arrives', key: 'due_date', offsetMinutes: -60 })).toBe(
      '1 hour before due_date arrives',
    );
    expect(
      summarizeTrigger({ type: 'property_changed', key: 'status', to: { value: 'Done' } }),
    ).toBe('When status changes to Done');
    expect(summarizeTrigger({ type: 'webhook' })).toBe('A trigger this version of Nix cannot show');
  });
});
