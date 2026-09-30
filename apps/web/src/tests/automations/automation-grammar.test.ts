import { describe, expect, it } from 'vitest';

import {
  automationActionSchema,
  automationConditionSchema,
  automationTriggerSchema,
} from '../../automations/automation-grammar';

describe('automation trigger schemas', () => {
  it('reads each of the three version 1 triggers', () => {
    expect(
      automationTriggerSchema.safeParse({
        type: 'schedule',
        freq: 'weekly',
        interval: 2,
        weekdays: ['mo', 'fr'],
        time: '08:30',
        timeZone: 'Europe/London',
        startDate: '2026-09-30',
      }).success,
    ).toBe(true);
    expect(
      automationTriggerSchema.safeParse({
        type: 'date_arrives',
        key: 'due_date',
        offsetMinutes: -1440,
        time: '09:00',
      }).success,
    ).toBe(true);
    expect(
      automationTriggerSchema.safeParse({
        type: 'property_changed',
        key: 'status',
        from: { value: 'Open' },
        to: { value: null },
      }).success,
    ).toBe(true);
  });

  it('refuses the shapes Core refuses', () => {
    // An unknown member: Core is strict both ways, so the client is too.
    expect(
      automationTriggerSchema.safeParse({
        type: 'schedule',
        freq: 'daily',
        interval: 1,
        time: '09:00',
        colour: 'red',
      }).success,
    ).toBe(false);
    // A time that is not HH:mm.
    expect(
      automationTriggerSchema.safeParse({ type: 'schedule', freq: 'daily', interval: 1, time: '9' })
        .success,
    ).toBe(false);
    // An offset more than a week away.
    expect(
      automationTriggerSchema.safeParse({ type: 'date_arrives', key: 'due', offsetMinutes: 10_081 })
        .success,
    ).toBe(false);
    // A system property.
    expect(
      automationTriggerSchema.safeParse({ type: 'property_changed', key: '$due_set_by' }).success,
    ).toBe(false);
    // A trigger this schema version does not define.
    expect(automationTriggerSchema.safeParse({ type: 'webhook' }).success).toBe(false);
  });
});

describe('automation condition and action schemas', () => {
  it('reads conditions with and without a compared value', () => {
    expect(
      automationConditionSchema.safeParse({ key: 'status', op: 'equals', value: 'Done' }).success,
    ).toBe(true);
    expect(automationConditionSchema.safeParse({ key: 'status', op: 'is_empty' }).success).toBe(
      true,
    );
    expect(automationConditionSchema.safeParse({ key: 'status', op: 'contains' }).success).toBe(
      false,
    );
  });

  it('reads the three available actions and their item references', () => {
    expect(
      automationActionSchema.safeParse({
        type: 'set_property',
        target: 'triggering_item',
        key: 'status',
        value: 'Done',
      }).success,
    ).toBe(true);
    expect(
      automationActionSchema.safeParse({
        type: 'create_item',
        parent: { itemId: '11111111-1111-4111-8111-111111111111' },
        itemType: 'note',
        title: 'Review for {date}',
      }).success,
    ).toBe(true);
    expect(automationActionSchema.safeParse({ type: 'notify', title: 'Hello' }).success).toBe(true);
  });

  it('does not offer create_from_template before its worker lane ships', () => {
    expect(automationActionSchema.safeParse({ type: 'create_from_template' }).success).toBe(false);
  });
});
