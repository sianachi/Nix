import { describe, expect, it } from 'vitest';
import { createFakePorts } from './testing/fake-ports.js';
import { runWorkspaceTool } from './run.js';
import { loadPreviewContext } from './context.js';
import { readStructure } from './structure/read-structure.js';

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
    specJson: '',
    ...extras,
  });
function setup() {
  const fake = createFakePorts();
  fake.query.mockImplementation((endpoint: { operation: string }) =>
    Promise.resolve(
      endpoint.operation === 'schema.get'
        ? { properties: [], declared: [], inherit: true }
        : endpoint.operation === 'views.getConfigurations' || endpoint.operation === 'views.get'
          ? { views: [], unrenderable: [], default: 'document' }
          : { id: itemId, workspaceId: workspace, parentId: null, title: 'Plan', type: 'note' },
    ),
  );
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
    ['read_structure', 'items.get'],
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
    await runWorkspaceTool(ports, workspace, input('restore_item', { itemId }), signal);
    expect(query).not.toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'items.get' }),
      expect.anything(),
    );
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

  it('checks every destination ancestor before reading that ancestor schema', async () => {
    const { ports, query, signal } = setup();
    const ancestorId = '33333333-3333-4333-8333-333333333333';
    query.mockImplementation((endpoint: { operation: string; path: string }) => {
      if (endpoint.operation === 'items.get') {
        const id = endpoint.path.split('/').at(-1);
        return Promise.resolve({
          id,
          workspaceId: id === itemId ? workspace : 'foreign',
          parentId: id === itemId ? ancestorId : null,
          title: id === itemId ? 'Parent' : 'Outside parent',
        });
      }
      if (endpoint.operation === 'schema.get')
        return Promise.resolve({ properties: [], declared: [], inherit: true });
      throw new Error(`unexpected query ${endpoint.operation}`);
    });
    const args = {
      operation: 'create_entries',
      itemId: '',
      parentId: itemId,
      title: '',
      markdown: '',
      query: '',
      propertiesJson: '',
      specJson: '{"entries":[{"title":"A"}]}',
    } as const;
    await expect(loadPreviewContext(ports, workspace, args, signal)).rejects.toThrow(
      'outside this workspace',
    );
    expect(
      query.mock.calls.map(([endpoint]) => (endpoint as { operation: string }).operation),
    ).toEqual(['items.get', 'items.get']);
  });

  it('refuses a cross-workspace legacy target before loading its structure', async () => {
    const { ports, query, signal } = setup();
    query.mockResolvedValue({
      id: itemId,
      workspaceId: 'foreign',
      parentId: null,
      title: 'Outside',
      type: 'note',
    });
    const args = {
      operation: 'rename_item',
      itemId,
      parentId: '',
      title: 'Next',
      markdown: '',
      query: '',
      propertiesJson: '',
      specJson: '',
    } as const;
    await expect(loadPreviewContext(ports, workspace, args, signal)).rejects.toThrow('outside');
    expect(
      query.mock.calls.map(([endpoint]) => (endpoint as { operation: string }).operation),
    ).toEqual(['items.get']);
  });

  it('passes apply_template inputs from specJson through to preflight and apply', async () => {
    const { ports, query, execute, signal } = setup();
    query.mockImplementation((endpoint: { operation: string }) => {
      if (endpoint.operation === 'templates.list')
        return Promise.resolve({ templates: [{ id: itemId }], capabilities: { canManage: true } });
      if (endpoint.operation === 'items.get')
        return Promise.resolve({
          id: itemId,
          workspaceId: workspace,
          parentId: null,
          type: 'note',
        });
      throw new Error(`unexpected query ${endpoint.operation}`);
    });
    execute.mockImplementation(
      (endpoint: { operation: string; body?: { inputs?: Record<string, string> } }) => {
        if (endpoint.operation === 'templates.preflight')
          return Promise.resolve({ canApply: true, conflicts: [] });
        if (endpoint.operation === 'templates.apply')
          return Promise.resolve({
            targetItemId: itemId,
            createdItems: [],
            alreadyApplied: false,
            fileTransferPending: false,
          });
        throw new Error(`unexpected execute ${endpoint.operation}`);
      },
    );
    const outcome = await runWorkspaceTool(
      ports,
      workspace,
      input('apply_template', {
        itemId,
        parentId: itemId,
        title: 'Applied',
        specJson: '{"inputs":{"due":"2026-10-01"}}',
      }),
      signal,
      { toolId: 'tool', claimId: 'claim' },
    );
    expect(JSON.parse(outcome.text)).toMatchObject({ alreadyApplied: false });
    expect(
      execute.mock.calls.find(
        ([endpoint]) => (endpoint as { operation: string }).operation === 'templates.preflight',
      )?.[0],
    ).toMatchObject({ body: { inputs: { due: '2026-10-01' } } });
    expect(
      execute.mock.calls.find(
        ([endpoint]) => (endpoint as { operation: string }).operation === 'templates.apply',
      )?.[0],
    ).toMatchObject({ body: { inputs: { due: '2026-10-01' } } });
  });

  it('loads root-level create_structured context without looking up an empty parent id', async () => {
    const { ports, query, signal } = setup();
    const args = {
      operation: 'create_structured',
      itemId: '',
      parentId: '',
      title: 'Board',
      markdown: '',
      query: '',
      propertiesJson: '',
      specJson: '{"recipe":"board","fields":[]}',
    } as const;
    const context = await loadPreviewContext(ports, workspace, args, signal);
    expect(context.destination).toEqual({ title: 'Workspace root', path: [] });
    expect(context.inheritedFields).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('accepts apply_template with omitted specJson inputs during preflight', async () => {
    const { ports, query, execute, signal } = setup();
    query.mockImplementation((endpoint: { operation: string }) => {
      if (endpoint.operation === 'templates.list')
        return Promise.resolve({ templates: [{ id: itemId }], capabilities: { canManage: true } });
      throw new Error(`unexpected query ${endpoint.operation}`);
    });
    execute.mockResolvedValue({ canApply: true, conflicts: [] });
    const args = {
      operation: 'apply_template',
      itemId,
      parentId: '',
      title: 'Applied',
      markdown: '',
      query: '',
      propertiesJson: '',
      specJson: '',
    } as const;
    const context = await loadPreviewContext(ports, workspace, args, signal);
    expect(context.preflight).toMatchObject({ canApply: true });
    const preflightCall = execute.mock.calls.find(
      ([endpoint]) => (endpoint as { operation: string }).operation === 'templates.preflight',
    );
    expect(preflightCall?.[0]).toMatchObject({ operation: 'templates.preflight' });
    expect((preflightCall?.[0] as { body: object }).body).not.toHaveProperty('inputs');
  });

  it('sends create_structured through the named request with publishing disabled', async () => {
    const { ports, execute, signal } = setup();
    execute.mockImplementation((endpoint: { operation: string }) =>
      endpoint.operation === 'items.createStructured'
        ? Promise.resolve({ item: { id: itemId, title: 'Board' }, publicForm: null })
        : Promise.reject(new Error(`unexpected execute ${endpoint.operation}`)),
    );
    const outcome = await runWorkspaceTool(
      ports,
      workspace,
      input('create_structured', {
        title: 'Board',
        specJson: '{"recipe":"board","fields":[]}',
      }),
      signal,
      { fence: '|' },
    );
    expect(JSON.parse(outcome.text)).toMatchObject({ id: itemId, created: true });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      operation: 'items.createStructured',
      body: { publishInteractiveFormViewId: null },
    });
    expect(outcome.touchedParents).toEqual([null]);
  });

  it('refuses add_view when the approved fingerprint is stale', async () => {
    const { ports, execute, signal } = setup();
    await expect(
      runWorkspaceTool(
        ports,
        workspace,
        input('add_view', { itemId, specJson: '{"views":[{"kind":"list"}]}' }),
        signal,
        { fence: 'stale' },
      ),
    ).rejects.toThrow('changed since you approved');
    expect(execute).not.toHaveBeenCalled();
  });

  it('adds a view through appendViewSetup with publishing disabled', async () => {
    const { ports, execute, signal } = setup();
    const outcome = await runWorkspaceTool(
      ports,
      workspace,
      input('add_view', { itemId, specJson: '{"views":[{"kind":"list"}]}' }),
      signal,
      { fence: '|' },
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      operation: 'views.appendSetup',
      body: { makeDefault: false, publishInteractiveFormViewId: null },
    });
    expect(outcome.touchedParents).toEqual([itemId]);
  });

  it('dispatches add_fields through appendViewSetup with only new properties', async () => {
    const { ports, execute, signal } = setup();
    const outcome = await runWorkspaceTool(
      ports,
      workspace,
      input('add_fields', {
        itemId,
        specJson: '{"fields":[{"key":"status","label":"Status","type":"text"}]}',
      }),
      signal,
      { fence: '|' },
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      operation: 'views.appendSetup',
      body: {
        properties: [{ key: 'status', type: 'text' }],
        views: [],
        makeDefault: false,
        publishInteractiveFormViewId: null,
      },
    });
    expect(outcome.touchedParents).toEqual([itemId]);
  });

  it('keeps every existing property when adding generated fields', async () => {
    for (let count = 1; count <= 8; count++) {
      const { ports, execute, signal } = setup();
      const fields = Array.from({ length: count }, (_, index) => ({
        key: `added_${index.toString()}`,
        label: `Added ${index.toString()}`,
        type: 'text',
      }));
      await runWorkspaceTool(
        ports,
        workspace,
        input('add_fields', { itemId, specJson: JSON.stringify({ fields }) }),
        signal,
        { fence: '|' },
      );
      const endpoint = execute.mock.calls[0]?.[0] as
        | { operation: string; body?: { properties?: { key: string }[]; views?: unknown[] } }
        | undefined;
      expect(endpoint?.operation).toBe('views.appendSetup');
      expect(endpoint?.body?.properties?.map((property) => property.key)).toEqual(
        fields.map((field) => field.key),
      );
      expect(endpoint?.body?.views).toEqual([]);
    }
  });

  it('refuses edit_form when the approved fingerprint is stale', async () => {
    const { ports, execute, signal } = setup();
    await expect(
      runWorkspaceTool(
        ports,
        workspace,
        input('edit_form', {
          itemId,
          specJson: '{"viewId":"form","form":{"pages":[]}}',
        }),
        signal,
        { fence: 'stale' },
      ),
    ).rejects.toThrow('changed since you approved');
    expect(execute).not.toHaveBeenCalled();
  });

  it('dispatches set_recurrence after validating the current due date value', async () => {
    const { ports, query, execute, signal } = setup();
    query.mockImplementation((endpoint: { operation: string }) => {
      if (endpoint.operation === 'schema.get')
        return Promise.resolve({
          properties: [
            { key: 'due_date', label: 'Due date', type: 'due_date', options: [], required: false },
          ],
          declared: [
            { key: 'due_date', label: 'Due date', type: 'due_date', options: [], required: false },
          ],
          inherit: true,
        });
      if (endpoint.operation === 'views.getConfigurations')
        return Promise.resolve({ views: [], unrenderable: [], default: 'document' });
      if (endpoint.operation === 'items.get')
        return Promise.resolve({
          id: itemId,
          workspaceId: workspace,
          parentId: null,
          title: 'Plan',
          type: 'note',
          properties: { due_date: '2027-03-02' },
          computed: {},
        });
      throw new Error(`unexpected query ${endpoint.operation}`);
    });
    const outcome = await runWorkspaceTool(
      ports,
      workspace,
      input('set_recurrence', {
        itemId,
        specJson: '{"frequency":"weekly","interval":1,"weekdays":[1,3],"until":"2027-04-02"}',
      }),
      signal,
      { fence: 'due_date:due_date|' },
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      operation: 'recurrence.set',
      body: { freq: 'weekly', interval: 1, weekdays: ['mo', 'we'], until: '2027-04-02' },
    });
    expect(outcome.touchedParents).toEqual([itemId]);
  });

  it('dispatches edit_form with the companion preserved and an empty property replacement set', async () => {
    const { ports, query, execute, signal } = setup();
    const formView = {
      id: 'form',
      name: 'Signup',
      kind: 'interactive_form',
      columns: [],
      groupBy: null,
      groupOrder: [],
      dateProperty: null,
      sortBy: null,
      sortDescending: false,
      mode: null,
      coverProperty: null,
      endDateProperty: null,
      cardSize: null,
      layout: null,
      filters: [],
      companionViewId: 'responses',
      companionPlacement: 'beside',
      interactiveForm: {
        pages: [],
        titleMode: 'generated',
        titleFieldBlockId: null,
        confirmationTitle: 'Thanks',
        confirmationMessage: '',
      },
    };
    const companion = {
      id: 'responses',
      name: 'Responses',
      kind: 'list',
      columns: ['status'],
      groupBy: null,
      groupOrder: [],
      dateProperty: null,
      sortBy: null,
      sortDescending: false,
      mode: null,
      coverProperty: null,
      endDateProperty: null,
      cardSize: null,
      layout: null,
      filters: [],
      companionViewId: null,
      companionPlacement: null,
      interactiveForm: null,
    };
    query.mockImplementation((endpoint: { operation: string }) => {
      if (endpoint.operation === 'schema.get')
        return Promise.resolve({
          properties: [
            { key: 'status', label: 'Status', type: 'text', options: [], required: false },
          ],
          declared: [
            { key: 'status', label: 'Status', type: 'text', options: [], required: false },
          ],
          inherit: true,
        });
      if (endpoint.operation === 'views.getConfigurations')
        return Promise.resolve({ views: [formView, companion], unrenderable: [], default: 'form' });
      if (endpoint.operation === 'items.get')
        return Promise.resolve({
          id: itemId,
          workspaceId: workspace,
          parentId: null,
          title: 'Plan',
          type: 'note',
          properties: {},
          computed: {},
        });
      throw new Error(`unexpected query ${endpoint.operation}`);
    });
    await runWorkspaceTool(
      ports,
      workspace,
      input('edit_form', {
        itemId,
        specJson: JSON.stringify({
          viewId: 'form',
          form: { pages: [{ title: 'Details', blocks: [{ field: 'status' }] }] },
        }),
      }),
      signal,
      { fence: 'status:text|form:interactive_form,responses:list' },
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      operation: 'views.replaceSetup',
      path: '/api/v1/items/22222222-2222-4222-8222-222222222222/view-setups/form',
      body: {
        schema: { properties: [], inherit: true },
        originalPropertyKeys: [],
        views: [
          { id: 'form', kind: 'interactive_form', companionViewId: 'responses' },
          { id: 'responses', columns: ['status'], kind: 'list' },
        ],
        publishInteractiveFormViewId: null,
      },
    });
  });

  it('read_structure reports inherited and computed fields with a bounded child count', async () => {
    const { ports, query, paginate, signal } = setup();
    query.mockImplementation((endpoint: { operation: string }) => {
      if (endpoint.operation === 'items.get')
        return Promise.resolve({
          id: itemId,
          workspaceId: workspace,
          parentId: null,
          title: 'Board',
          type: 'note',
        });
      if (endpoint.operation === 'schema.get')
        return Promise.resolve({
          properties: [
            {
              key: 'status',
              label: 'Status',
              type: 'select',
              options: ['To read'],
              required: true,
            },
            { key: 'total', label: 'Total', type: 'formula', options: [], required: false },
          ],
          declared: [
            {
              key: 'status',
              label: 'Status',
              type: 'select',
              options: ['To read'],
              required: true,
            },
          ],
          inherit: true,
        });
      if (endpoint.operation === 'views.getConfigurations')
        return Promise.resolve({
          views: [{ id: 'view', name: 'List', kind: 'list', dateProperty: null }],
          unrenderable: [],
          default: 'view',
        });
      throw new Error(`unexpected query ${endpoint.operation}`);
    });
    paginate.mockImplementation(async function* () {
      await Promise.resolve();
      yield { id: itemId };
      yield { id: '33333333-3333-4333-8333-333333333333' };
    });
    const result = await readStructure(ports, workspace, itemId, signal);
    expect(result.fields).toMatchObject([
      { key: 'status', inherited: false, computed: false },
      { key: 'total', inherited: true, computed: true },
    ]);
    expect(result.childCount).toBe('many');
    expect(paginate).toHaveBeenCalledOnce();
  });

  it('validates every create_entries value before the first write', async () => {
    const { ports, query, execute, signal } = setup();
    query.mockImplementation((endpoint: { operation: string }) => {
      if (endpoint.operation === 'items.get')
        return Promise.resolve({
          id: itemId,
          workspaceId: workspace,
          parentId: null,
          title: 'Board',
          type: 'note',
        });
      if (endpoint.operation === 'schema.get')
        return Promise.resolve({
          properties: [
            { key: 'status', label: 'Status', type: 'select', options: ['Done'], required: false },
          ],
          declared: [
            { key: 'status', label: 'Status', type: 'select', options: ['Done'], required: false },
          ],
          inherit: true,
        });
      throw new Error(`unexpected query ${endpoint.operation}`);
    });
    await expect(
      runWorkspaceTool(
        ports,
        workspace,
        input('create_entries', {
          parentId: itemId,
          specJson:
            '{"entries":[{"title":"First","values":{"status":"Invalid"}},{"title":"Second","values":{"missing":true}}]}',
        }),
        signal,
        { fence: 'status:select|' },
      ),
    ).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it('stops create_entries after the first failed create and reports later rows untouched', async () => {
    const { ports, query, execute, signal } = setup();
    query.mockImplementation((endpoint: { operation: string }) =>
      Promise.resolve(
        endpoint.operation === 'schema.get'
          ? { properties: [], declared: [], inherit: true }
          : { id: itemId, workspaceId: workspace, parentId: null, title: 'Board', type: 'note' },
      ),
    );
    let writes = 0;
    execute.mockImplementation((endpoint: { operation: string }) => {
      if (endpoint.operation === 'items.create') {
        writes += 1;
        return writes === 1
          ? Promise.resolve({ id: '33333333-3333-4333-8333-333333333333' })
          : Promise.reject(new Error('write failed'));
      }
      return Promise.reject(new Error(`unexpected execute ${endpoint.operation}`));
    });
    const outcome = await runWorkspaceTool(
      ports,
      workspace,
      input('create_entries', {
        parentId: itemId,
        specJson: '{"entries":[{"title":"First"},{"title":"Second"},{"title":"Third"}]}',
      }),
      signal,
      { fence: '|' },
    );
    expect(JSON.parse(outcome.text)).toMatchObject({
      created: [{ index: 0, id: '33333333-3333-4333-8333-333333333333' }],
      failed: { index: 1, reason: 'write failed' },
      notAttempted: [2],
    });
    expect(writes).toBe(2);
  });

  it('reports an unconfirmed entry body and never retries its create', async () => {
    const { ports, query, execute, bodies, signal } = setup();
    query.mockImplementation((endpoint: { operation: string }) =>
      Promise.resolve(
        endpoint.operation === 'schema.get'
          ? { properties: [], declared: [], inherit: true }
          : { id: itemId, workspaceId: workspace, parentId: null, title: 'Board', type: 'note' },
      ),
    );
    execute.mockResolvedValue({ id: '33333333-3333-4333-8333-333333333333' });
    bodies.append.mockRejectedValue(new Error('connection lost'));
    const outcome = await runWorkspaceTool(
      ports,
      workspace,
      input('create_entries', {
        parentId: itemId,
        specJson: '{"entries":[{"title":"First","markdown":"body"}]}',
      }),
      signal,
      { fence: '|' },
    );
    expect(JSON.parse(outcome.text)).toMatchObject({
      created: [{ index: 0, id: '33333333-3333-4333-8333-333333333333' }],
      failed: { index: 0, reason: 'The entry was created but its body was not confirmed.' },
      contentConfirmed: false,
    });
    expect(execute).toHaveBeenCalledOnce();
  });
});
