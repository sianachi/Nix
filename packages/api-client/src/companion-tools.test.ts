import { describe, expect, it, vi } from 'vitest';
import { runWorkspaceTool } from './companion-tools.js';
import type { NixClient } from './client.js';

const workspace = '11111111-1111-4111-8111-111111111111';
const itemId = '22222222-2222-4222-8222-222222222222';
const input = (operation: string, extras = {}) =>
  JSON.stringify({
    operation,
    itemId: '',
    parentId: '',
    title: '',
    markdown: '',
    query: '',
    propertiesJson: '',
    ...extras,
  });
function setup() {
  const query = vi.fn().mockResolvedValue({ id: itemId, workspaceId: workspace, type: 'note' });
  const execute = vi.fn().mockResolvedValue({ id: itemId, title: 'Plan' });
  const bodies = { read: vi.fn(), append: vi.fn() };
  const paginate = vi.fn(async function* () {
    await Promise.resolve();
    yield { id: itemId, workspaceId: workspace, type: 'note', isDeleted: true };
  });
  const client = { query, execute, paginate } as unknown as NixClient;
  return { client, query, execute, paginate, bodies, signal: new AbortController().signal };
}
describe('permission-scoped companion tools', () => {
  it.each(['list_views', 'query_view', 'create_view', 'update_view', 'delete_view'])(
    'refuses unsupported view operation %s without pretending it was executed',
    async (operation) => {
      const { client, query, execute, bodies, signal } = setup();
      await expect(
        runWorkspaceTool(client, workspace, input(operation, { itemId }), bodies, signal),
      ).rejects.toThrow();
      expect(query).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(bodies.append).not.toHaveBeenCalled();
    },
  );
  it('resolves UUID searches directly inside the current workspace', async () => {
    const { client, query, bodies, signal } = setup();
    const result = JSON.parse(
      await runWorkspaceTool(client, workspace, input('search', { query: itemId }), bodies, signal),
    ) as { results: { id: string }[] };
    expect(result.results[0]?.id).toBe(itemId);
    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'items.get' }),
      expect.anything(),
    );
  });
  it.each([
    ['read_item', 'items.get'],
    ['read_schema', 'schema.get'],
    ['rename_item', 'items.rename'],
    ['move_item', 'items.move'],
    ['set_properties', 'properties.set'],
    ['trash_item', 'items.delete'],
  ])('routes %s through the normal Nix client', async (operation, expected) => {
    const { client, query, execute, bodies, signal } = setup();
    await runWorkspaceTool(
      client,
      workspace,
      input(operation, { itemId, title: 'Renamed', propertiesJson: '{"status":"Done"}' }),
      bodies,
      signal,
    );
    expect([...query.mock.calls, ...execute.mock.calls]).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([expect.objectContaining({ operation: expected })]),
      ]),
    );
  });
  it.each(['read_note', 'append_note'])(
    'uses bounded note-body access for %s',
    async (operation) => {
      const { client, bodies, signal } = setup();
      bodies.read.mockResolvedValue({ markdown: 'Existing', truncated: false });
      bodies.append.mockResolvedValue({ appended: true });
      await runWorkspaceTool(
        client,
        workspace,
        input(operation, { itemId, markdown: 'Append only' }),
        bodies,
        signal,
      );
      expect(operation === 'read_note' ? bodies.read : bodies.append).toHaveBeenCalledOnce();
    },
  );
  it('bounds list results and tells the model when they are incomplete', async () => {
    const { client, paginate, bodies, signal } = setup();
    paginate.mockImplementation(async function* () {
      await Promise.resolve();
      for (let i = 0; i < 60; i++)
        yield { id: itemId, workspaceId: workspace, type: 'note', isDeleted: false };
    });
    const result = JSON.parse(
      await runWorkspaceTool(client, workspace, input('list_items'), bodies, signal),
    ) as { items: unknown[]; truncated: boolean };
    expect(result.items).toHaveLength(50);
    expect(result.truncated).toBe(true);
  });
  it('refuses restoration when the target is absent from this workspace trash', async () => {
    const { client, paginate, execute, bodies, signal } = setup();
    paginate.mockImplementation(async function* () {
      await Promise.resolve();
      yield { id: itemId, workspaceId: 'another-workspace', type: 'note', isDeleted: true };
    });
    await expect(
      runWorkspaceTool(client, workspace, input('restore_item', { itemId }), bodies, signal),
    ).rejects.toThrow('not found');
    expect(execute).not.toHaveBeenCalled();
  });
  it('rejects a foreign destination before creating anything', async () => {
    const { client, query, execute, bodies, signal } = setup();
    query.mockResolvedValue({ workspaceId: 'another-workspace' });
    await expect(
      runWorkspaceTool(
        client,
        workspace,
        input('create_note', { parentId: itemId, title: 'No' }),
        bodies,
        signal,
      ),
    ).rejects.toThrow('outside');
    expect(execute).not.toHaveBeenCalled();
  });
  it('does not retry a failed mutation', async () => {
    const { client, execute, bodies, signal } = setup();
    execute.mockRejectedValue(new Error('connection lost'));
    await expect(
      runWorkspaceTool(
        client,
        workspace,
        input('rename_item', { itemId, title: 'No retry' }),
        bodies,
        signal,
      ),
    ).rejects.toThrow('connection lost');
    expect(execute).toHaveBeenCalledOnce();
  });
  it('restores an item from workspace trash even though ordinary item reads hide it', async () => {
    const { client, query, execute, paginate, bodies, signal } = setup();
    query.mockRejectedValue(new Error('not found: deleted items are hidden'));
    await runWorkspaceTool(client, workspace, input('restore_item', { itemId }), bodies, signal);
    expect(query).not.toHaveBeenCalled();
    expect(paginate).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'items.trash' }),
      expect.anything(),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'items.restore' }),
      expect.anything(),
    );
  });
  it('creates content and returns its identity to the model', async () => {
    const { client, execute, bodies, signal } = setup();
    const result = await runWorkspaceTool(
      client,
      workspace,
      input('create_note', { title: 'Plan', markdown: '# Plan\n\n- First task' }),
      bodies,
      signal,
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(bodies.append).toHaveBeenCalledWith(itemId, '# Plan\n\n- First task', signal);
    expect(JSON.parse(result)).toMatchObject({ id: itemId, contentConfirmed: true });
  });
  it('reports partial creation honestly and never retries the create', async () => {
    const { client, execute, bodies, signal } = setup();
    bodies.append.mockRejectedValue(new Error('connection lost'));
    const result = await runWorkspaceTool(
      client,
      workspace,
      input('create_note', { title: 'Plan', markdown: 'Body' }),
      bodies,
      signal,
    );
    expect(JSON.parse(result)).toMatchObject({
      id: itemId,
      created: true,
      contentConfirmed: false,
    });
    expect(execute).toHaveBeenCalledOnce();
  });
  it.each(['read_note', 'append_note', 'rename_item', 'move_item', 'set_properties', 'trash_item'])(
    'rejects cross-workspace %s before access or mutation',
    async (operation) => {
      const { client, query, execute, bodies, signal } = setup();
      query.mockResolvedValue({ workspaceId: 'another-workspace', type: 'note' });
      await expect(
        runWorkspaceTool(
          client,
          workspace,
          input(operation, {
            itemId,
            title: 'Changed',
            markdown: 'New text',
            propertiesJson: '{}',
          }),
          bodies,
          signal,
        ),
      ).rejects.toThrow('outside this workspace');
      expect(execute).not.toHaveBeenCalled();
      expect(bodies.read).not.toHaveBeenCalled();
      expect(bodies.append).not.toHaveBeenCalled();
    },
  );
  it('filters search results before sending data to the model', async () => {
    const { client, query, bodies, signal } = setup();
    query.mockResolvedValue({
      results: [
        { id: 'allowed', workspaceId: workspace },
        { id: 'private', workspaceId: 'other' },
      ],
      truncated: true,
    });
    const result = await runWorkspaceTool(
      client,
      workspace,
      input('search', { query: 'plan' }),
      bodies,
      signal,
    );
    expect(result).not.toContain('private');
    expect(JSON.parse(result)).toMatchObject({ truncated: true });
  });
  it('refuses unknown operations and model-provided URLs', async () => {
    const { client, execute, bodies, signal } = setup();
    await expect(
      runWorkspaceTool(client, workspace, input('shell'), bodies, signal),
    ).rejects.toThrow();
    await expect(
      runWorkspaceTool(
        client,
        workspace,
        input('read_note', { itemId: 'https://example.com' }),
        bodies,
        signal,
      ),
    ).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
});
