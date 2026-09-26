import { describe, expect, it } from 'vitest';
import { blueprintSchema, type Blueprint, type Node } from '@nix/structure-spec';
import { planBuild } from './plan.js';

const clock = {
  today: () => '2026-09-26',
  timeZone: () => 'Europe/London',
  now: () => new Date('2026-09-26T12:00:00.000Z'),
};

function blueprint(root: Node): Blueprint {
  return blueprintSchema.parse({ version: 1, title: 'Reading Log', summary: '', root });
}

function plan(root: Node, options: { parentId?: string | null; sandboxExists?: boolean } = {}) {
  return planBuild(blueprint(root), {
    parentId: options.parentId ?? null,
    sandboxExists: options.sandboxExists ?? false,
    clock,
  });
}

describe('planBuild', () => {
  it('places parent create steps before child create steps in depth-first order', () => {
    const result = plan({
      id: 'root',
      title: 'Root',
      views: [{ kind: 'list' }],
      children: [
        { id: 'first', title: 'First' },
        { id: 'second', title: 'Second', children: [{ id: 'nested', title: 'Nested' }] },
      ],
    });

    expect(result.nodeOrder).toEqual(['root', 'first', 'second', 'nested']);
    expect(
      result.steps
        .filter((step) => step.kind === 'createItem' || step.kind === 'createStructuredItem')
        .map((step) => step.nodeId),
    ).toEqual(['root', 'first', 'second', 'nested']);
    const child = result.steps.find(
      (step) => step.kind === 'createItem' && step.nodeId === 'nested',
    );
    expect(child).toMatchObject({ parentNodeId: 'second' });
  });

  it('adds the sandbox step only for a missing default destination', () => {
    expect(plan({ id: 'root', title: 'Root' }).steps[0]).toEqual({ kind: 'ensureSandbox' });
    expect(plan({ id: 'root', title: 'Root' }, { sandboxExists: true }).steps[0]).toMatchObject({
      kind: 'createItem',
      sandboxParent: true,
    });
    expect(plan({ id: 'root', title: 'Root' }, { parentId: 'destination' }).steps[0]).toMatchObject(
      {
        kind: 'createItem',
        parentId: 'destination',
      },
    );
    expect(plan({ id: 'root', title: 'Root' }, { parentId: 'destination' }).steps).not.toContain({
      kind: 'ensureSandbox',
    });
  });

  it('sets habit start date and time zone from the injected clock', () => {
    const result = plan({
      id: 'root',
      title: 'Root',
      children: [
        {
          id: 'habit',
          title: 'Daily reading',
          habit: { frequency: 'daily', target: 1, unit: 'book' },
        },
      ],
    });
    expect(result.steps).toContainEqual({
      kind: 'setHabit',
      target: { nodeId: 'habit' },
      settings: {
        frequency: 'daily',
        weekdays: null,
        startDate: '2026-09-26',
        timezone: 'Europe/London',
        target: 1,
        unit: 'book',
      },
    });
  });

  it('prefixes sample titles while preserving the blueprint root title', () => {
    const result = plan({
      id: 'root',
      title: 'Node root title',
      children: [{ id: 'sample', title: 'Example book', sample: true }],
    });
    expect(result.steps).toContainEqual(
      expect.objectContaining({ kind: 'createItem', nodeId: 'root', title: 'Reading Log' }),
    );
    expect(result.steps).toContainEqual(
      expect.objectContaining({
        kind: 'createItem',
        nodeId: 'sample',
        title: 'Sample: Example book',
        sample: true,
      }),
    );
  });

  it('produces the same plan for the same blueprint and clock', () => {
    const bp = blueprint({
      id: 'root',
      title: 'Root',
      fields: [{ label: 'Status', type: 'select', options: ['To do', 'Done'] }],
      views: [{ kind: 'board', groupBy: 'status' }],
      children: [{ id: 'task', title: 'Task', values: { status: 'To do' } }],
    });
    const options = { parentId: null, sandboxExists: true, clock };
    expect(planBuild(bp, options)).toEqual(planBuild(bp, options));
  });

  it('refuses a plan with 81 writes', () => {
    const children = Array.from({ length: 39 }, (_, index) => ({
      id: `item-${String(index)}`,
      title: `Item ${String(index)}`,
      markdown: 'Body',
    }));
    expect(() => plan({ id: 'root', title: 'Root', markdown: 'Body', children })).toThrow(
      'The plan exceeds the write budget.',
    );
  });
});
