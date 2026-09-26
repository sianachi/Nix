import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { petConnectionSchema, type NixClient } from '@nix/api-client';
import type * as Companion from '@nix/companion';
import { PetWorkTools } from '../../pets/pet-work-tools';
import { onItemChildrenChanged } from '../../lib/item-children-changed';
import { MemoryRouter } from 'react-router';

const client = vi.hoisted(() => ({ execute: vi.fn(), query: vi.fn(), invalidate: vi.fn() }));
vi.mock('../../api/api-client-provider', () => ({ useApiClient: () => client }));
// The executor's own behaviour is covered by packages/companion/src/run.test.ts; here it
// runs for real against the mocked Nix client above, wrapped in a spy so a test can assert
// the card forwards this request's toolId and claimId into the run options.
const runWorkspaceToolSpy = vi.hoisted(() => vi.fn());
vi.mock('@nix/companion', async () => {
  const actual = await vi.importActual<typeof Companion>('@nix/companion');
  runWorkspaceToolSpy.mockImplementation((...args: Parameters<typeof actual.runWorkspaceTool>) =>
    actual.runWorkspaceTool(...args),
  );
  return { ...actual, runWorkspaceTool: runWorkspaceToolSpy };
});
const runtime = petConnectionSchema.parse({
  provider: 'chatgpt',
  status: 'connected',
  reason: '',
  canConnect: false,
  tools: [
    {
      id: 'tool-1',
      arguments: JSON.stringify({
        operation: 'create_note',
        title: 'Plan',
        markdown: '',
        itemId: '',
        parentId: '',
        query: '',
        propertiesJson: '',
      }),
      status: 'pending',
      result: '',
      claimId: '',
    },
  ],
});
function show() {
  return render(
    <PetWorkTools
      client={client as unknown as NixClient}
      runtime={runtime}
      workspaceId="11111111-1111-4111-8111-111111111111"
      petId="22222222-2222-4222-8222-222222222222"
      onChange={vi.fn()}
    />,
  );
}
async function approveRequest() {
  const button = screen.getByRole('button', { name: 'Approve request' });
  await waitFor(() => {
    expect(button).toBeEnabled();
  });
  await userEvent.click(button);
}
describe('companion work approvals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });
  it('never executes when the server claim is uncertain', async () => {
    client.execute.mockRejectedValue(new Error('lost claim response'));
    show();
    expect(client.execute).not.toHaveBeenCalled();
    await approveRequest();
    await screen.findByRole('alert');
    expect(client.execute).toHaveBeenCalledTimes(1);
    expect(client.execute.mock.calls[0]?.[0]).toMatchObject({ body: { operation: 'tool_claim' } });
    expect(screen.queryByRole('button', { name: 'Approve request' })).not.toBeInTheDocument();
  });
  it('describes the planned action before the permission buttons', async () => {
    show();
    const description = await screen.findByText(/I will create a note named “Plan”/);
    const approval = screen.getByRole('button', { name: 'Approve request' });
    expect(
      description.compareDocumentPosition(approval) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(client.execute).not.toHaveBeenCalled();
  });

  it.each([
    [
      { operation: 'list_templates', query: 'reading' },
      /I will list the templates this workspace can apply\./,
    ],
    [
      { operation: 'list_templates', query: '' },
      /I will list the templates this workspace can apply\./,
    ],
    [
      { operation: 'read_template', itemId: '33333333-3333-4333-8333-333333333333' },
      /I will read the outline of the linked template\./,
    ],
    [
      {
        operation: 'apply_template',
        itemId: '33333333-3333-4333-8333-333333333333',
        title: 'Reading log',
      },
      /I will create “Reading log” from the linked template at the top level/,
    ],
  ])('describes a template operation in plain language: %o', async (overrides, pattern) => {
    if ('operation' in overrides && overrides.operation === 'apply_template') {
      client.query.mockResolvedValue({
        templates: [{ id: '33333333-3333-4333-8333-333333333333' }],
      });
      client.execute.mockResolvedValue({
        additions: { items: 1, fields: 0, views: 0 },
        conflicts: [],
        canApply: true,
      });
    }
    render(
      <PetWorkTools
        client={client as unknown as NixClient}
        runtime={{
          ...runtime,
          tools: (runtime.tools ?? []).map((tool) => ({
            ...tool,
            arguments: JSON.stringify({
              title: '',
              markdown: '',
              itemId: '',
              parentId: '',
              query: '',
              propertiesJson: '',
              ...overrides,
            }),
          })),
        }}
        workspaceId="11111111-1111-4111-8111-111111111111"
        petId="22222222-2222-4222-8222-222222222222"
        onChange={vi.fn()}
      />,
      { wrapper: MemoryRouter },
    );
    expect(await screen.findByText(pattern)).toBeInTheDocument();
  });

  it('labels a user refusal as declined rather than a failed operation', () => {
    render(
      <PetWorkTools
        client={client as unknown as NixClient}
        runtime={{
          ...runtime,
          tools:
            runtime.tools?.map((tool) => ({
              ...tool,
              status: 'failed',
              result: 'Declined by the user. Do not retry this change unless asked.',
            })) ?? [],
        }}
        workspaceId="11111111-1111-4111-8111-111111111111"
        petId="22222222-2222-4222-8222-222222222222"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Declined');
    expect(screen.queryByRole('button', { name: 'Approve request' })).not.toBeInTheDocument();
  });

  it('does not ask again after a stale refresh or reopening an uncertain request', async () => {
    client.execute.mockRejectedValue(new Error('lost response'));
    const view = show();
    await approveRequest();
    await screen.findByRole('alert');
    view.unmount();
    show();
    expect(screen.queryByRole('button', { name: 'Approve request' })).not.toBeInTheDocument();
    expect(screen.getByText('Approval submitted. Waiting for confirmation.')).toBeVisible();
    expect(client.execute).toHaveBeenCalledTimes(1);
  });
  it('returns a declined result without performing a Nix mutation', async () => {
    const changed = vi.fn();
    const unsubscribe = onItemChildrenChanged(changed);
    client.execute.mockImplementation(
      (endpoint: { body: { operation: string; requestId: string } }) =>
        Promise.resolve({
          ...runtime,
          tools: runtime.tools?.map((tool) => ({
            ...tool,
            status: 'claimed',
            claimId: endpoint.body.requestId,
          })),
        }),
    );
    show();
    await userEvent.click(screen.getByRole('button', { name: 'Decline request' }));
    await waitFor(() => {
      expect(client.execute).toHaveBeenCalledTimes(2);
    });
    expect(client.execute.mock.calls[1]?.[0]).toMatchObject({
      body: {
        operation: 'tool_result',
        toolSuccess: false,
        toolResult: expect.stringContaining('Declined') as unknown,
      },
    });
    expect(changed).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('blocks approval when preview context proves the target is outside this workspace', async () => {
    const scopedRuntime = {
      ...runtime,
      tools:
        runtime.tools?.map((tool) => ({
          ...tool,
          arguments: JSON.stringify({
            operation: 'read_item',
            itemId: '33333333-3333-4333-8333-333333333333',
            title: '',
            markdown: '',
            parentId: '',
            query: '',
            propertiesJson: '',
          }),
        })) ?? [],
    };
    client.query.mockResolvedValue({
      workspaceId: '44444444-4444-4444-8444-444444444444',
      title: 'Private fixture title',
    });
    client.execute.mockImplementation((endpoint: { body: { requestId: string } }) =>
      Promise.resolve({
        ...scopedRuntime,
        tools: scopedRuntime.tools.map((tool) => ({
          ...tool,
          status: 'claimed',
          claimId: endpoint.body.requestId,
        })),
      }),
    );
    render(
      <PetWorkTools
        client={client as unknown as NixClient}
        runtime={scopedRuntime}
        workspaceId="11111111-1111-4111-8111-111111111111"
        petId="22222222-2222-4222-8222-222222222222"
        onChange={vi.fn()}
      />,
      { wrapper: MemoryRouter },
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('preview could not be loaded');
    expect(screen.getByRole('button', { name: 'Approve request' })).toBeDisabled();
    expect(client.execute).not.toHaveBeenCalled();
    expect(client.invalidate).not.toHaveBeenCalled();
  });
  it('executes once even with a double click and a stale pending snapshot', async () => {
    const changed = vi.fn();
    const unsubscribe = onItemChildrenChanged(changed);
    client.execute.mockImplementation(
      (endpoint: { operation: string; body: { operation?: string; requestId?: string } }) => {
        if (endpoint.operation === 'items.create')
          return Promise.resolve({ id: '33333333-3333-4333-8333-333333333333' });
        return Promise.resolve({
          ...runtime,
          tools: runtime.tools?.map((tool) => ({
            ...tool,
            status: endpoint.body.operation === 'tool_result' ? 'completed' : 'claimed',
            claimId: endpoint.body.requestId,
          })),
        });
      },
    );
    show();
    const approval = screen.getByRole('button', { name: 'Approve request' });
    await waitFor(() => expect(approval).toBeEnabled());
    await userEvent.dblClick(approval);
    await waitFor(() => {
      expect(client.execute).toHaveBeenCalledTimes(3);
    });
    expect(
      client.execute.mock.calls.filter(
        ([endpoint]) => (endpoint as { operation: string }).operation === 'items.create',
      ),
    ).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Approve request' })).not.toBeInTheDocument();
    expect(changed).toHaveBeenCalledExactlyOnceWith({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      parentId: null,
    });
    expect(client.invalidate).toHaveBeenCalledWith(['items']);
    expect(runWorkspaceToolSpy).toHaveBeenCalledOnce();
    const claimRequestId = (client.execute.mock.calls[0]?.[0] as { body: { requestId: string } })
      .body.requestId;
    expect(runWorkspaceToolSpy).toHaveBeenCalledWith(
      expect.anything(),
      '11111111-1111-4111-8111-111111111111',
      expect.any(String),
      expect.anything(),
      { toolId: 'tool-1', claimId: claimRequestId, mode: 'chat', fence: '|' },
    );
    unsubscribe();
  });

  it('disables approval for preview problems and sends only those problems back to the pet', async () => {
    const invalidRuntime = {
      ...runtime,
      tools:
        runtime.tools?.map((tool) => ({
          ...tool,
          arguments: JSON.stringify({
            operation: 'create_structured',
            title: 'Board',
            itemId: '',
            parentId: '',
            markdown: '',
            query: '',
            propertiesJson: '',
            specJson: JSON.stringify({ recipe: 'drive', fields: [], inherit: true }),
          }),
        })) ?? [],
    };
    client.execute.mockImplementation(
      (endpoint: { body: { operation: string; requestId: string } }) =>
        Promise.resolve({
          ...invalidRuntime,
          tools: invalidRuntime.tools.map((tool) => ({
            ...tool,
            status: endpoint.body.operation === 'tool_result' ? 'completed' : 'claimed',
            claimId: endpoint.body.requestId,
          })),
        }),
    );
    render(
      <PetWorkTools
        client={client as unknown as NixClient}
        runtime={invalidRuntime}
        workspaceId="11111111-1111-4111-8111-111111111111"
        petId="22222222-2222-4222-8222-222222222222"
        onChange={vi.fn()}
      />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot run');
    expect(screen.getByRole('button', { name: 'Approve request' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Send problems to pet' }));
    await waitFor(() => {
      expect(client.execute).toHaveBeenCalledTimes(2);
    });
    expect(runWorkspaceToolSpy).not.toHaveBeenCalled();
    const resultCall: unknown = client.execute.mock.calls[1]?.[0];
    expect(resultCall).toMatchObject({
      body: { operation: 'tool_result', toolSuccess: false },
    });
    const resultBody = (resultCall as { body: { toolResult: unknown } }).body;
    expect(resultBody.toolResult).toMatch(/^Declined: the design has problems\./);
  });

  it('passes the preview fingerprint to execution and notifies every touched parent', async () => {
    const changed = vi.fn();
    const unsubscribe = onItemChildrenChanged(changed);
    const structuredRuntime = {
      ...runtime,
      tools:
        runtime.tools?.map((tool) => ({
          ...tool,
          arguments: JSON.stringify({
            operation: 'create_structured',
            title: 'Reading log',
            itemId: '',
            parentId: '',
            markdown: '',
            query: '',
            propertiesJson: '',
            specJson: JSON.stringify({
              recipe: 'board',
              fields: [{ label: 'Status', type: 'select', options: ['To read', 'Done'] }],
              views: [{ kind: 'board', groupBy: 'Status' }],
              inherit: true,
            }),
          }),
        })) ?? [],
    };
    client.execute.mockImplementation(
      (endpoint: { body: { operation: string; requestId: string } }) =>
        Promise.resolve({
          ...structuredRuntime,
          tools: structuredRuntime.tools.map((tool) => ({
            ...tool,
            status: endpoint.body.operation === 'tool_result' ? 'completed' : 'claimed',
            claimId: endpoint.body.requestId,
          })),
        }),
    );
    runWorkspaceToolSpy.mockResolvedValueOnce({
      text: 'created',
      readOnly: false,
      touchedParents: [
        '11111111-1111-4111-8111-111111111111',
        null,
        '33333333-3333-4333-8333-333333333333',
      ],
    });
    render(
      <PetWorkTools
        client={client as unknown as NixClient}
        runtime={structuredRuntime}
        workspaceId="11111111-1111-4111-8111-111111111111"
        petId="22222222-2222-4222-8222-222222222222"
        onChange={vi.fn()}
      />,
      { wrapper: MemoryRouter },
    );
    await approveRequest();
    await waitFor(() => {
      expect(client.execute).toHaveBeenCalledTimes(2);
    });
    expect(runWorkspaceToolSpy.mock.calls[0]?.[4]).toMatchObject({ mode: 'chat', fence: '|' });
    expect(changed.mock.calls).toEqual([
      [
        {
          workspaceId: '11111111-1111-4111-8111-111111111111',
          parentId: '11111111-1111-4111-8111-111111111111',
        },
      ],
      [{ workspaceId: '11111111-1111-4111-8111-111111111111', parentId: null }],
      [
        {
          workspaceId: '11111111-1111-4111-8111-111111111111',
          parentId: '33333333-3333-4333-8333-333333333333',
        },
      ],
    ]);
    expect(client.invalidate).toHaveBeenCalledWith(['items']);
    unsubscribe();
  });

  it('invalidates the template catalog after a successful template application', async () => {
    const templateId = '33333333-3333-4333-8333-333333333333';
    const applyRuntime = {
      ...runtime,
      tools: (runtime.tools ?? []).map((tool) => ({
        ...tool,
        arguments: JSON.stringify({
          operation: 'apply_template',
          itemId: templateId,
          parentId: '',
          title: 'Reading log copy',
          markdown: '',
          query: '',
          propertiesJson: '',
          specJson: '',
        }),
      })),
    };
    client.query.mockResolvedValue({ templates: [{ id: templateId }] });
    client.execute.mockImplementation(
      (endpoint: { operation: string; body: { operation?: string; requestId?: string } }) => {
        if (endpoint.operation === 'templates.preflight')
          return Promise.resolve({
            additions: { items: 1, fields: 2, views: 1 },
            conflicts: [],
            canApply: true,
          });
        return Promise.resolve({
          ...applyRuntime,
          tools: applyRuntime.tools.map((tool) => ({
            ...tool,
            status: endpoint.body.operation === 'tool_result' ? 'completed' : 'claimed',
            claimId: endpoint.body.requestId,
          })),
        });
      },
    );
    runWorkspaceToolSpy.mockResolvedValueOnce({
      text: 'applied',
      readOnly: false,
      touchedParents: [null],
    });
    render(
      <PetWorkTools
        client={client as unknown as NixClient}
        runtime={applyRuntime}
        workspaceId="11111111-1111-4111-8111-111111111111"
        petId="22222222-2222-4222-8222-222222222222"
        onChange={vi.fn()}
      />,
      { wrapper: MemoryRouter },
    );
    await approveRequest();
    await waitFor(() => {
      expect(client.invalidate).toHaveBeenCalledWith(['templates']);
    });
  });
});
