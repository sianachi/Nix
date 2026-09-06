import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { petConnectionSchema, type NixClient } from '@nix/api-client';
import { PetWorkTools } from '../../pets/pet-work-tools';
import { onItemChildrenChanged } from '../../lib/item-children-changed';
import { MemoryRouter } from 'react-router';

const client = vi.hoisted(() => ({ execute: vi.fn(), query: vi.fn(), invalidate: vi.fn() }));
vi.mock('../../api/api-client-provider', () => ({ useApiClient: () => client }));
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
describe('companion work approvals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });
  it('never executes when the server claim is uncertain', async () => {
    client.execute.mockRejectedValue(new Error('lost claim response'));
    show();
    expect(client.execute).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Approve request' }));
    await screen.findByRole('alert');
    expect(client.execute).toHaveBeenCalledTimes(1);
    expect(client.execute.mock.calls[0]?.[0]).toMatchObject({ body: { operation: 'tool_claim' } });
    expect(screen.queryByRole('button', { name: 'Approve request' })).not.toBeInTheDocument();
  });
  it('describes the planned action before the permission buttons', () => {
    show();
    const description = screen.getByText(/I will create a note named “Plan”/);
    const approval = screen.getByRole('button', { name: 'Approve request' });
    expect(
      description.compareDocumentPosition(approval) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(client.execute).not.toHaveBeenCalled();
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
    await userEvent.click(screen.getByRole('button', { name: 'Approve request' }));
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

  it('reports a workspace preflight refusal without exposing the target or marking a write uncertain', async () => {
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
    await userEvent.click(screen.getByRole('button', { name: 'Approve request' }));
    await waitFor(() => { expect(client.execute).toHaveBeenCalledTimes(2); });
    expect(client.execute.mock.calls[1]?.[0]).toMatchObject({
      body: {
        toolSuccess: false,
        toolResult: 'The item is outside this workspace. No action was run.',
      },
    });
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
    await userEvent.dblClick(screen.getByRole('button', { name: 'Approve request' }));
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
    unsubscribe();
  });
});
