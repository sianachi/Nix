import { NixApiError } from '@nix/api-client';
import { describe, expect, it } from 'vitest';
import { createFakePorts } from '../testing/fake-ports.js';
import { executeBuild } from './build.js';

const workspace = '11111111-1111-4111-8111-111111111111';
const item = (id: string, title = 'Node') => ({
  id,
  workspaceId: workspace,
  parentId: null,
  title,
  type: 'note',
});

describe('blueprint build executor', () => {
  it('writes a plain parent schema and values before creating its child', async () => {
    const fake = createFakePorts();
    fake.query.mockResolvedValue(item('parent'));
    fake.execute
      .mockResolvedValueOnce(item('root'))
      .mockResolvedValueOnce({ properties: [], declared: [], inherit: true })
      .mockResolvedValueOnce(item('root'))
      .mockResolvedValueOnce(item('child'));
    const result = await executeBuild(
      fake.ports,
      workspace,
      {
        nodeOrder: ['root', 'child'],
        steps: [
          { kind: 'createItem', parentId: null, title: 'Root', properties: null, nodeId: 'root' },
          {
            kind: 'setNodeSchema',
            target: { nodeId: 'root' },
            schema: { properties: [], inherit: false },
          },
          { kind: 'setNodeProperties', target: { nodeId: 'root' }, properties: { status: 'Open' } },
          {
            kind: 'createItem',
            parentId: null,
            parentNodeId: 'root',
            title: 'Child',
            properties: null,
            nodeId: 'child',
          },
        ],
      },
      fake.signal,
    );
    expect(result.complete).toBe(true);
    expect(result.ledger.map((entry) => entry.step)).toEqual([
      'createItem',
      'setNodeSchema',
      'setNodeProperties',
      'createItem',
    ]);
    expect(
      fake.execute.mock.calls.map((call) => (call[0] as { operation: string }).operation),
    ).toEqual(['items.create', 'schema.set', 'properties.set', 'items.create']);
  });

  it('refuses a schema step aimed at an external item instead of a created node', async () => {
    const fake = createFakePorts();
    const result = await executeBuild(
      fake.ports,
      workspace,
      {
        nodeOrder: ['root'],
        steps: [
          {
            kind: 'setNodeSchema',
            target: { itemId: 'external' } as unknown as { nodeId: string },
            schema: { properties: [], inherit: true },
          },
        ],
      },
      fake.signal,
    );
    expect(result.complete).toBe(false);
    expect(result.ledger[0]).toMatchObject({ step: 'setNodeSchema', status: 'failed' });
    expect(fake.execute).not.toHaveBeenCalled();
  });

  it('stops after a failure and records the remaining steps as skipped', async () => {
    const fake = createFakePorts();
    fake.query.mockResolvedValue(item('parent'));
    fake.execute.mockResolvedValueOnce(item('root'));
    fake.execute.mockRejectedValueOnce(new Error('write failed'));
    const result = await executeBuild(
      fake.ports,
      workspace,
      {
        nodeOrder: ['root', 'child'],
        steps: [
          { kind: 'createItem', parentId: null, title: 'Root', properties: null, nodeId: 'root' },
          {
            kind: 'createItem',
            parentId: null,
            parentNodeId: 'root',
            title: 'Child',
            properties: null,
            nodeId: 'child',
          },
          { kind: 'appendBody', target: { nodeId: 'child' }, markdown: 'Body' },
        ],
      },
      fake.signal,
    );
    expect(result).toMatchObject({
      complete: false,
      rootId: 'root',
      instruction:
        'The draft is incomplete. Do not build again. Offer to move the draft to trash, then build a corrected design.',
    });
    expect(result.ledger.map(({ status }) => status)).toEqual(['done', 'failed', 'skipped']);
    expect(fake.execute).toHaveBeenCalledTimes(2);
  });

  it('reports 429 as rate limited and gives the wait instruction', async () => {
    const fake = createFakePorts();
    fake.query.mockResolvedValue(item('parent'));
    fake.execute.mockRejectedValueOnce(NixApiError.fromStatus(429));
    const result = await executeBuild(
      fake.ports,
      workspace,
      {
        nodeOrder: ['root'],
        steps: [
          { kind: 'createItem', parentId: null, title: 'Root', properties: null, nodeId: 'root' },
        ],
      },
      fake.signal,
    );
    expect(result.rateLimited).toBe(true);
    expect(result.instruction).toBe(
      'The draft is incomplete because Nix limited the write rate. Do not build again. Offer to move the draft to trash and try again in a minute.',
    );
    expect(fake.execute).toHaveBeenCalledOnce();
  });

  it('resolves sandboxParent, parentNodeId and node targets to created ids', async () => {
    const fake = createFakePorts();
    fake.query.mockResolvedValue(item('parent'));
    fake.paginate.mockImplementation(async function* () {
      await Promise.resolve();
      yield item('sandbox', 'Pet drafts');
    });
    fake.execute.mockResolvedValueOnce(item('root')).mockResolvedValueOnce(item('child'));
    fake.bodies.append.mockResolvedValue({ appended: true });
    const result = await executeBuild(
      fake.ports,
      workspace,
      {
        nodeOrder: ['root', 'child'],
        steps: [
          {
            kind: 'createItem',
            parentId: null,
            sandboxParent: true,
            title: 'Root',
            properties: null,
            nodeId: 'root',
          },
          {
            kind: 'createItem',
            parentId: null,
            parentNodeId: 'root',
            title: 'Child',
            properties: null,
            nodeId: 'child',
          },
          { kind: 'appendBody', target: { nodeId: 'child' }, markdown: 'Body' },
        ],
      },
      fake.signal,
    );
    expect(result.complete).toBe(true);
    expect(fake.execute).toHaveBeenCalledTimes(2);
    expect(fake.bodies.append).toHaveBeenCalledWith('child', 'Body', fake.signal);
    expect(result.rootId).toBe('root');
  });

  it('checks a provided destination workspace before the first write', async () => {
    const fake = createFakePorts();
    fake.query.mockResolvedValue({ id: 'parent', workspaceId: 'other', parentId: null });
    await expect(
      executeBuild(
        fake.ports,
        workspace,
        {
          nodeOrder: ['root'],
          steps: [
            {
              kind: 'createItem',
              parentId: 'parent',
              title: 'Root',
              properties: null,
              nodeId: 'root',
            },
          ],
        },
        fake.signal,
      ),
    ).rejects.toThrow('outside this workspace');
    expect(fake.execute).not.toHaveBeenCalled();
  });

  it('refuses when the previously approved sandbox disappeared and creation was not planned', async () => {
    const fake = createFakePorts();
    fake.paginate.mockImplementation(async function* () {
      await Promise.resolve();
      yield item('other', 'Other item');
    });
    await expect(
      executeBuild(
        fake.ports,
        workspace,
        {
          nodeOrder: ['root'],
          steps: [
            {
              kind: 'createItem',
              parentId: null,
              sandboxParent: true,
              title: 'Root',
              properties: null,
              nodeId: 'root',
            },
          ],
        },
        fake.signal,
      ),
    ).rejects.toThrow('changed since you approved');
    expect(fake.execute).not.toHaveBeenCalled();
  });

  it('stops between steps when aborted', async () => {
    const fake = createFakePorts();
    const controller = new AbortController();
    fake.execute.mockImplementation(async () => {
      await Promise.resolve();
      controller.abort();
      return item('root');
    });
    const result = await executeBuild(
      fake.ports,
      workspace,
      {
        nodeOrder: ['root', 'child'],
        steps: [
          { kind: 'createItem', parentId: null, title: 'Root', properties: null, nodeId: 'root' },
          {
            kind: 'createItem',
            parentId: null,
            parentNodeId: 'root',
            title: 'Child',
            properties: null,
            nodeId: 'child',
          },
        ],
      },
      controller.signal,
    );
    expect(result.complete).toBe(false);
    expect(result.ledger.map(({ status }) => status)).toEqual(['done', 'failed']);
    expect(fake.execute).toHaveBeenCalledOnce();
  });
});
