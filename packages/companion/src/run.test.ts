import { describe, expect, it } from 'vitest';
import { createFakePorts } from './testing/fake-ports.js';
import { runWorkspaceTool } from './run.js';

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
  const fake = createFakePorts();
  fake.query.mockResolvedValue({ id: itemId, workspaceId: workspace, type: 'note' });
  fake.execute.mockResolvedValue({ id: itemId, title: 'Plan' });
  fake.paginate.mockImplementation(async function* () {
    await Promise.resolve();
    yield { id: itemId, workspaceId: workspace, type: 'note', isDeleted: true };
  });
  return fake;
}
describe('workspace-scoped companion tools', () => {
  it.each(['list_views', 'query_view', 'create_view', 'update_view', 'delete_view'])(
    'refuses unsupported view operation %s without pretending it was executed',
    async (operation) => {
      const { ports, query, execute, bodies, signal } = setup();
      await expect(
        runWorkspaceTool(ports, workspace, input(operation, { itemId }), signal),
      ).rejects.toThrow();
      expect(query).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(bodies.append).not.toHaveBeenCalled();
    },
  );
  it('resolves UUID searches directly inside the current workspace', async () => {
    const { ports, query, signal } = setup();
    const outcome = await runWorkspaceTool(
      ports,
      workspace,
      input('search', { query: itemId }),
      signal,
    );
    const result = JSON.parse(outcome.text) as { results: { id: string }[] };
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
    const { ports, query, execute, signal } = setup();
    await runWorkspaceTool(
      ports,
      workspace,
      input(operation, { itemId, title: 'Renamed', propertiesJson: '{"status":"Done"}' }),
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
      const { ports, bodies, signal } = setup();
      bodies.read.mockResolvedValue({ markdown: 'Existing', truncated: false });
      bodies.append.mockResolvedValue({ appended: true });
      await runWorkspaceTool(
        ports,
        workspace,
        input(operation, { itemId, markdown: 'Append only' }),
        signal,
      );
      expect(operation === 'read_note' ? bodies.read : bodies.append).toHaveBeenCalledOnce();
    },
  );
  it('bounds list results and tells the model when they are incomplete', async () => {
    const { ports, paginate, signal } = setup();
    paginate.mockImplementation(async function* () {
      await Promise.resolve();
      for (let i = 0; i < 60; i++)
        yield { id: itemId, workspaceId: workspace, type: 'note', isDeleted: false };
    });
    const outcome = await runWorkspaceTool(ports, workspace, input('list_items'), signal);
    const result = JSON.parse(outcome.text) as { items: unknown[]; truncated: boolean };
    expect(result.items).toHaveLength(50);
    expect(result.truncated).toBe(true);
  });
  it('refuses restoration when the target is absent from this workspace trash', async () => {
    const { ports, paginate, execute, signal } = setup();
    paginate.mockImplementation(async function* () {
      await Promise.resolve();
      yield { id: itemId, workspaceId: 'another-workspace', type: 'note', isDeleted: true };
    });
    await expect(
      runWorkspaceTool(ports, workspace, input('restore_item', { itemId }), signal),
    ).rejects.toThrow('not found');
    expect(execute).not.toHaveBeenCalled();
  });
  it('rejects a foreign destination before creating anything', async () => {
    const { ports, query, execute, signal } = setup();
    query.mockResolvedValue({ workspaceId: 'another-workspace' });
    await expect(
      runWorkspaceTool(
        ports,
        workspace,
        input('create_note', { parentId: itemId, title: 'No' }),
        signal,
      ),
    ).rejects.toThrow('outside');
    expect(execute).not.toHaveBeenCalled();
  });
  it('does not retry a failed mutation', async () => {
    const { ports, execute, signal } = setup();
    execute.mockRejectedValue(new Error('connection lost'));
    await expect(
      runWorkspaceTool(
        ports,
        workspace,
        input('rename_item', { itemId, title: 'No retry' }),
        signal,
      ),
    ).rejects.toThrow('connection lost');
    expect(execute).toHaveBeenCalledOnce();
  });
  it('restores an item from workspace trash even though ordinary item reads hide it', async () => {
    const { ports, query, execute, paginate, signal } = setup();
    query.mockRejectedValue(new Error('not found: deleted items are hidden'));
    await runWorkspaceTool(ports, workspace, input('restore_item', { itemId }), signal);
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
    const { ports, execute, bodies, signal } = setup();
    const outcome = await runWorkspaceTool(
      ports,
      workspace,
      input('create_note', { title: 'Plan', markdown: '# Plan\n\n- First task' }),
      signal,
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(bodies.append).toHaveBeenCalledWith(itemId, '# Plan\n\n- First task', signal);
    expect(JSON.parse(outcome.text)).toMatchObject({ id: itemId, contentConfirmed: true });
  });
  it('reports partial creation honestly and never retries the create', async () => {
    const { ports, execute, bodies, signal } = setup();
    bodies.append.mockRejectedValue(new Error('connection lost'));
    const outcome = await runWorkspaceTool(
      ports,
      workspace,
      input('create_note', { title: 'Plan', markdown: 'Body' }),
      signal,
    );
    expect(JSON.parse(outcome.text)).toMatchObject({
      id: itemId,
      created: true,
      contentConfirmed: false,
    });
    expect(execute).toHaveBeenCalledOnce();
  });
  it.each(['read_note', 'append_note', 'rename_item', 'move_item', 'set_properties', 'trash_item'])(
    'rejects cross-workspace %s before access or mutation',
    async (operation) => {
      const { ports, query, execute, bodies, signal } = setup();
      query.mockResolvedValue({ workspaceId: 'another-workspace', type: 'note' });
      await expect(
        runWorkspaceTool(
          ports,
          workspace,
          input(operation, {
            itemId,
            title: 'Changed',
            markdown: 'New text',
            propertiesJson: '{}',
          }),
          signal,
        ),
      ).rejects.toThrow('outside this workspace');
      expect(execute).not.toHaveBeenCalled();
      expect(bodies.read).not.toHaveBeenCalled();
      expect(bodies.append).not.toHaveBeenCalled();
    },
  );
  it('filters search results before sending data to the model', async () => {
    const { ports, query, signal } = setup();
    query.mockResolvedValue({
      results: [
        { id: 'allowed', workspaceId: workspace },
        { id: 'private', workspaceId: 'other' },
      ],
      truncated: true,
    });
    const outcome = await runWorkspaceTool(
      ports,
      workspace,
      input('search', { query: 'plan' }),
      signal,
    );
    expect(outcome.text).not.toContain('private');
    expect(JSON.parse(outcome.text)).toMatchObject({ truncated: true });
  });
  it('refuses unknown operations and model-provided URLs', async () => {
    const { ports, execute, signal } = setup();
    await expect(runWorkspaceTool(ports, workspace, input('shell'), signal)).rejects.toThrow();
    await expect(
      runWorkspaceTool(
        ports,
        workspace,
        input('read_note', { itemId: 'https://example.com' }),
        signal,
      ),
    ).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
  it('names the destination of a create_note in touchedParents', async () => {
    const { ports, signal } = setup();
    const outcome = await runWorkspaceTool(
      ports,
      workspace,
      input('create_note', { title: 'Plan', parentId: itemId }),
      signal,
    );
    expect(outcome.touchedParents).toEqual([itemId]);
    expect(outcome.readOnly).toBe(false);
  });
  it('reports no touched parent and read-only for a read operation', async () => {
    const { ports, signal } = setup();
    const outcome = await runWorkspaceTool(
      ports,
      workspace,
      input('read_item', { itemId }),
      signal,
    );
    expect(outcome.touchedParents).toEqual([]);
    expect(outcome.readOnly).toBe(true);
  });
});
