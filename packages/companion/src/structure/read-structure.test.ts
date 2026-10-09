import { describe, expect, it } from 'vitest';
import { createFakePorts } from '../testing/fake-ports.js';
import { readStructure } from './read-structure.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const itemId = '22222222-2222-4222-8222-222222222222';

describe('pet structure evidence', () => {
  it('returns full view configuration, computed definitions and Core decisions', async () => {
    const fake = createFakePorts();
    fake.query.mockImplementation((endpoint: { operation: string }) => {
      if (endpoint.operation === 'items.get')
        return Promise.resolve({ id: itemId, workspaceId, title: 'Tasks', type: 'note' });
      if (endpoint.operation === 'schema.get')
        return Promise.resolve({
          inherit: false,
          declared: [{ key: 'status' }, { key: 'effort' }],
          properties: [
            { key: 'status', label: 'Status', type: 'select', options: ['Done'], required: true },
            {
              key: 'effort',
              label: 'Effort',
              type: 'formula',
              options: [],
              required: false,
              expression: 'hours * 2',
              aggregate: null,
              source: null,
            },
          ],
        });
      if (endpoint.operation === 'views.getConfigurations')
        return Promise.resolve({
          views: [
            {
              id: 'list',
              name: 'Work',
              kind: 'list',
              columns: ['status'],
              filters: [{ property: 'status', operator: 'equals', value: 'Done' }],
              sorts: [{ property: 'status', descending: true }],
              collapsedGroups: ['Done'],
              aggregates: [{ property: 'hours', function: 'sum' }],
              companionViewId: 'schedule',
              companionPlacement: 'below',
            },
            { id: 'schedule', name: 'Schedule', kind: 'calendar', dateProperty: 'removed' },
            { id: 'checklist', name: 'Tasks', kind: 'checklist', doneProperty: 'finished' },
            {
              id: 'matrix',
              name: 'Workloads',
              kind: 'matrix',
              groupBy: 'status',
              rowBy: 'priority',
            },
            {
              id: 'chart',
              name: 'Effort',
              kind: 'chart',
              measure: 'sum',
              measureProperty: 'hours',
              chart: { kind: 'area', period: 'week', splitBy: 'status', stacked: true },
            },
          ],
          unrenderable: ['schedule'],
          default: 'list',
          hideDocument: true,
        });
      throw new Error(`Unexpected query ${endpoint.operation}`);
    });
    const result = await readStructure(fake.ports, workspaceId, itemId, fake.signal);
    expect(result).toMatchObject({
      defaultView: 'list',
      hideDocument: true,
      inheritsFields: false,
      childCount: 0,
      viewCapacity: { limit: 12, current: 5, remaining: 7 },
    });
    expect(result.fields[1]).toMatchObject({
      computed: true,
      expression: 'hours * 2',
      inherited: false,
    });
    expect(result.views[0]).toMatchObject({
      isDefault: true,
      canRender: true,
      filters: [{ value: 'Done' }],
      companionViewId: 'schedule',
    });
    expect(result.views[1]).toMatchObject({
      canRender: false,
      isDefault: false,
      dateProperty: 'removed',
    });
    expect(result.views[1]?.problems[0]).toContain('does not supply the specific reason');
    expect(result.views[2]?.doneProperty).toBe('finished');
    expect(result.views[3]?.rowBy).toBe('priority');
    expect(result.views[4]?.chart).toMatchObject({ kind: 'area', stacked: true });
    expect(fake.execute).not.toHaveBeenCalled();
  });

  it.each([12, 13])('reports no remaining capacity with %i stored views', async (count) => {
    const fake = createFakePorts();
    fake.query.mockImplementation((endpoint: { operation: string }) =>
      Promise.resolve(
        endpoint.operation === 'items.get'
          ? { id: itemId, workspaceId, title: 'Views', type: 'note' }
          : endpoint.operation === 'schema.get'
            ? { inherit: true, declared: [], properties: [] }
            : {
                views: Array.from({ length: count }, (_, i) => ({
                  id: `list-${String(i)}`,
                  name: 'List',
                  kind: 'list',
                })),
                unrenderable: [],
                default: 'list-0',
                hideDocument: false,
              },
      ),
    );
    expect(
      (await readStructure(fake.ports, workspaceId, itemId, fake.signal)).viewCapacity,
    ).toEqual({ limit: 12, current: count, remaining: 0 });
    expect(fake.execute).not.toHaveBeenCalled();
  });

  it('refuses a foreign workspace before reading structure or children', async () => {
    const fake = createFakePorts();
    fake.query.mockResolvedValue({ id: itemId, workspaceId: 'another-workspace' });
    await expect(readStructure(fake.ports, workspaceId, itemId, fake.signal)).rejects.toThrow(
      'outside',
    );
    expect(fake.query).toHaveBeenCalledOnce();
    expect(fake.paginate).not.toHaveBeenCalled();
  });
});
