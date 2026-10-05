import { describe, expect, it } from 'vitest';

import { create, dryRun, get, list, remove, run, runs, update } from './automations.js';
import {
  automationRuleResponseSchema,
  automationRunResponseSchema,
  automationTestResponseSchema,
} from '../schemas/automations.js';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const RULE = '33333333-3333-4333-8333-333333333333';
const ITEM = '11111111-1111-4111-8111-111111111111';

const input = {
  name: 'Morning review',
  enabled: true,
  scopeItemId: null,
  trigger: { type: 'schedule', freq: 'daily', interval: 1, time: '08:00' },
  conditions: [],
  actions: [{ type: 'notify', title: 'Review {date}' }],
};

describe('the automations resource', () => {
  it('list reads the caller own rules for one workspace', () => {
    expect(list(WORKSPACE)).toMatchObject({
      kind: 'query',
      path: `/api/v1/workspaces/${WORKSPACE}/automations`,
    });
  });

  it('create POSTs the rule document to the workspace collection', () => {
    expect(create(WORKSPACE, input)).toMatchObject({
      kind: 'command',
      method: 'POST',
      path: `/api/v1/workspaces/${WORKSPACE}/automations`,
      body: input,
    });
  });

  it('get and remove address one rule', () => {
    expect(get(RULE)).toMatchObject({ kind: 'query', path: `/api/v1/automations/${RULE}` });
    expect(remove(RULE)).toMatchObject({
      kind: 'command',
      method: 'DELETE',
      path: `/api/v1/automations/${RULE}`,
    });
  });

  it('update PUTs the whole rule behind the expected revision', () => {
    expect(update(RULE, 4, input)).toMatchObject({
      method: 'PUT',
      path: `/api/v1/automations/${RULE}`,
      body: { expectedRevision: 4, rule: input },
    });
  });

  it('runs pages with an opaque cursor only when one is given', () => {
    expect(runs(RULE).query).not.toHaveProperty('cursor');
    expect(runs(RULE, 'c1')).toMatchObject({
      path: `/api/v1/automations/${RULE}/runs`,
      query: { cursor: 'c1' },
    });
  });

  it('run and test POST the optional triggering item, null when absent', () => {
    expect(run(RULE)).toMatchObject({
      method: 'POST',
      path: `/api/v1/automations/${RULE}/run`,
      body: { itemId: null },
    });
    expect(dryRun(RULE, ITEM)).toMatchObject({
      method: 'POST',
      path: `/api/v1/automations/${RULE}/test`,
      body: { itemId: ITEM },
    });
  });
});

describe('the automation schemas', () => {
  it('accept an unknown run status and reason so new Core codes still parse', () => {
    const parsed = automationRunResponseSchema.parse({
      id: RULE,
      ruleId: RULE,
      itemId: null,
      origin: 'manual',
      depth: 0,
      status: 'some_future_status',
      reason: 'some_future_reason',
      createdAt: '2026-09-30T12:00:00Z',
    });
    expect(parsed.status).toBe('some_future_status');
  });

  it('parse a rule response with its JSON trigger, conditions and actions untouched', () => {
    const parsed = automationRuleResponseSchema.parse({
      id: RULE,
      workspaceId: WORKSPACE,
      name: 'Morning review',
      enabled: false,
      scopeItemId: null,
      trigger: input.trigger,
      conditions: [],
      actions: input.actions,
      revision: 2,
      consecutiveFailures: 5,
      disabledReason: 'repeated_failures',
      lastRunAt: null,
      createdAt: '2026-09-30T12:00:00Z',
      updatedAt: '2026-09-30T12:00:00Z',
    });
    expect(parsed.trigger).toEqual(input.trigger);
    expect(parsed.disabledReason).toBe('repeated_failures');
  });

  it('parse a dry run with its rendered action previews', () => {
    const parsed = automationTestResponseSchema.parse({
      wouldRun: true,
      reason: null,
      actions: [{ index: 0, type: 'notify', itemId: null, key: null, title: 'Review', body: '' }],
    });
    expect(parsed.actions[0]?.title).toBe('Review');
  });
});
