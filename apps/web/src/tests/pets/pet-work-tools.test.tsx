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
  it('passes the complete approved source fingerprint for template saving', async () => {
    const fingerprint = 'a'.repeat(64);
    const saveRuntime = {
      ...runtime,
      tools: (runtime.tools ?? []).map((tool) => ({
        ...tool,
        arguments: JSON.stringify({
          operation: 'save_as_template',
          itemId: '33333333-3333-4333-8333-333333333333',
          parentId: '',
          title: 'Job hunt',
          markdown: '',
          query: '',
          propertiesJson: '',
          specJson: '{}',
        }),
      })),
    };
    client.query.mockImplementation((endpoint: { operation: string; path: string }) => {
      if (endpoint.operation !== 'templates.capture.preview')
        throw new Error(`Unexpected preview query: ${endpoint.operation}`);
      const excluded = endpoint.path.includes('excludeSampleDescendants=true');
      return Promise.resolve({
        fingerprint,
        captureFingerprint: excluded ? 'b'.repeat(64) : fingerprint,
        sourceTitle: 'Applications',
        itemCount: excluded ? 2 : 3,
      });
    });
    client.execute.mockImplementation(
      (endpoint: { body: { operation: string; requestId: string } }) =>
        Promise.resolve({
          ...saveRuntime,
          tools: saveRuntime.tools.map((tool) => ({
            ...tool,
            status: endpoint.body.operation === 'tool_result' ? 'completed' : 'claimed',
            claimId: endpoint.body.requestId,
          })),
        }),
    );
    runWorkspaceToolSpy.mockResolvedValueOnce({
      text: 'saved',
      readOnly: false,
      touchedParents: [],
    });
    render(
      <PetWorkTools
        client={client as unknown as NixClient}
        runtime={saveRuntime}
        workspaceId="11111111-1111-4111-8111-111111111111"
        petId="22222222-2222-4222-8222-222222222222"
        mode="consult"
        onChange={vi.fn()}
      />,
      { wrapper: MemoryRouter },
    );
    expect(await screen.findByText(/I will save “Applications” and 1 children/)).toBeVisible();
    expect(screen.getByText('2 items to copy, 1 template write')).toBeVisible();
    expect(screen.queryByText(/0 fields, 0 views/)).not.toBeInTheDocument();
    await approveRequest();
    await waitFor(() => {
      expect(runWorkspaceToolSpy).toHaveBeenCalledOnce();
    });
    expect(runWorkspaceToolSpy.mock.calls[0]?.[4]).toMatchObject({
      mode: 'consult',
      fence: fingerprint,
    });
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
  it('shows a "Declined" receipt once a plain decline\'s tool_result succeeds', async () => {
    // The server snapshot deliberately stays `pending` here (a stale or slow-to-settle round
    // trip) so the only source of the "Declined" text is the receipt L4 adds after the
    // `tool_result` POST for a plain decline succeeds - not `tool.status`/`tool.result` on the
    // snapshot itself, which `WriteReceiptRow` also derives a "Declined" label from.
    client.execute.mockImplementation(
      (endpoint: { body: { operation: string; requestId: string } }) =>
        Promise.resolve({
          ...runtime,
          tools: runtime.tools?.map((tool) => ({
            ...tool,
            status: endpoint.body.operation === 'tool_claim' ? 'claimed' : 'pending',
            claimId: endpoint.body.requestId,
          })),
        }),
    );
    show();
    await userEvent.click(screen.getByRole('button', { name: 'Decline request' }));
    await waitFor(() => {
      expect(screen.getByText('Declined')).toBeVisible();
    });
    expect(screen.queryByRole('button', { name: 'Decline request' })).not.toBeInTheDocument();
  });

  it.each(['create_note', 'append_note'])(
    'shows the full pending %s content inline, with no folding, plus its line count',
    async (operation) => {
      const content = 'x'.repeat(340);
      render(
        <PetWorkTools
          client={client as unknown as NixClient}
          runtime={{
            ...runtime,
            tools: (runtime.tools ?? []).map((tool) => ({
              ...tool,
              arguments: JSON.stringify({
                operation,
                title: operation === 'create_note' ? 'Plan' : '',
                markdown: content,
                itemId: operation === 'append_note' ? '33333333-3333-4333-8333-333333333333' : '',
                parentId: '',
                query: '',
                propertiesJson: '',
              }),
            })),
          }}
          workspaceId="11111111-1111-4111-8111-111111111111"
          petId="22222222-2222-4222-8222-222222222222"
          onChange={vi.fn()}
        />,
        { wrapper: MemoryRouter },
      );
      // Security fix S1: a pending card never folds its content behind "Show content" - the
      // full text is already in the DOM, in a focusable region, with a plain line count next
      // to it.
      const region = await screen.findByRole('region', {
        name: operation === 'create_note' ? 'Note body' : 'Added note text',
      });
      expect(region).toHaveTextContent(content);
      expect(screen.queryByText('Show content')).not.toBeInTheDocument();
      expect(
        screen.getByText(operation === 'create_note' ? 'Note body (1 line)' : 'Added note text (1 line)'),
      ).toBeVisible();
    },
  );

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
    // Both read-only - list_templates and read_template are never previewed (see
    // `isAutoReadOperation`), so each is announced by its own one-line sentence rather than a
    // headline built from the preview model. Both auto-run (the default device preference), so
    // the sentence is already in its present-progressive form while the claim is in flight
    // (UX fix U3).
    [{ operation: 'list_templates', query: 'reading' }, /^Listing templates$/],
    [{ operation: 'list_templates', query: '' }, /^Listing templates$/],
    [
      { operation: 'read_template', itemId: '33333333-3333-4333-8333-333333333333' },
      /^Reading a template$/,
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
    // UX fix U16: the status word is no longer its own live region - the row beside it already
    // carries the announcement.
    expect(screen.getByText('Declined')).toBeVisible();
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

  it('refuses a read whose target is outside this workspace when it runs automatically', async () => {
    // A read never previews - see `isAutoReadOperation` - so the cross-workspace guard now runs
    // only at execution time, inside `runWorkspaceTool`'s own `checkItem`. It still refuses
    // before any content crosses back into a tool result.
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
    await waitFor(() => {
      expect(runWorkspaceToolSpy).toHaveBeenCalledOnce();
    });
    await expect(
      runWorkspaceToolSpy.mock.results[0]?.value as Promise<unknown>,
    ).rejects.toThrow('outside this workspace');
    await waitFor(() => {
      expect(client.execute).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByRole('button', { name: 'Approve request' })).not.toBeInTheDocument();
    expect(client.invalidate).not.toHaveBeenCalled();
    // The refusal itself must never carry the private fixture's content back to the pet.
    const toolResultCall = client.execute.mock.calls.find(
      ([endpoint]) => (endpoint as { body: { operation: string } }).body.operation === 'tool_result',
    );
    expect(JSON.stringify(toolResultCall?.[0])).not.toContain('Private fixture title');
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

  it('automatically declines a write whose preview has problems, once, and shows a receipt', async () => {
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
      (endpoint: {
        body: { operation: string; requestId: string; toolResult?: string };
      }) =>
        Promise.resolve({
          ...invalidRuntime,
          tools: invalidRuntime.tools.map((tool) => ({
            ...tool,
            status: endpoint.body.operation === 'tool_result' ? 'completed' : 'claimed',
            claimId: endpoint.body.requestId,
            ...(endpoint.body.operation === 'tool_result'
              ? { result: endpoint.body.toolResult ?? '' }
              : {}),
          })),
        }),
    );
    const onNeedsDecisionChange = vi.fn();
    render(
      <PetWorkTools
        client={client as unknown as NixClient}
        runtime={invalidRuntime}
        workspaceId="11111111-1111-4111-8111-111111111111"
        petId="22222222-2222-4222-8222-222222222222"
        onChange={vi.fn()}
        onNeedsDecisionChange={onNeedsDecisionChange}
      />,
    );
    await waitFor(() => {
      expect(client.execute).toHaveBeenCalledTimes(2);
    });
    expect(runWorkspaceToolSpy).not.toHaveBeenCalled();
    // A write whose preview has problems is auto-declined, never something the owner is asked to
    // decide - `needsDecision` (and this prop) must exclude it once its problems are known.
    expect(onNeedsDecisionChange).toHaveBeenLastCalledWith([]);
    const resultCall: unknown = client.execute.mock.calls[1]?.[0];
    expect(resultCall).toMatchObject({
      body: { operation: 'tool_result', toolSuccess: false },
    });
    const resultBody = (resultCall as { body: { toolResult: unknown } }).body;
    expect(resultBody.toolResult).toMatch(/^Declined: the design has problems\./);
    // `onChange` is a no-op here (as elsewhere in this file), so the rendered `tool` never
    // reflects the persisted result - only the receipt this component tracks itself does. The
    // richer "Sent N problems back to {pet}" wording (`WriteReceiptRow` in pet-work-tools.tsx)
    // needs that persisted `tool.result`, which the live app supplies through `setRuntime`.
    expect(screen.getByText('Declined')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Approve request' })).not.toBeInTheDocument();
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
        mode="consult"
        onChange={vi.fn()}
      />,
      { wrapper: MemoryRouter },
    );
    await approveRequest();
    await waitFor(() => {
      expect(client.execute).toHaveBeenCalledTimes(2);
    });
    expect(runWorkspaceToolSpy.mock.calls[0]?.[4]).toMatchObject({ mode: 'consult', fence: '|' });
    expect(client.execute.mock.calls[0]?.[0]).toMatchObject({
      body: { mode: 'consult', operation: 'tool_claim' },
    });
    expect(client.execute.mock.calls[1]?.[0]).toMatchObject({
      body: { mode: 'consult', operation: 'tool_result' },
    });
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

  it('runs consult blueprint validation without approval buttons or workspace reads', async () => {
    const validationRuntime = {
      ...runtime,
      tools: (runtime.tools ?? []).map((tool) => ({
        ...tool,
        arguments: JSON.stringify({
          operation: 'validate_blueprint',
          itemId: '',
          parentId: '',
          title: '',
          markdown: '',
          query: '',
          propertiesJson: '',
          specJson: JSON.stringify({
            version: 1,
            title: 'Design draft',
            summary: 'A small design.',
            root: { id: 'plan', title: 'Plan' },
          }),
        }),
      })),
    };
    let finishValidation: (() => void) | undefined;
    client.execute.mockImplementation(
      (endpoint: {
        body: { operation: string; requestId: string; toolResult?: string; toolSuccess?: boolean };
      }) =>
        endpoint.body.operation === 'tool_claim'
          ? new Promise<void>((resolve) => {
              finishValidation = resolve;
            }).then(() => ({
              ...validationRuntime,
              tools: validationRuntime.tools.map((tool) => ({
                ...tool,
                status: 'claimed',
                claimId: endpoint.body.requestId,
              })),
            }))
          : Promise.resolve({
              ...validationRuntime,
              tools: validationRuntime.tools.map((tool) => ({
                ...tool,
                status: endpoint.body.operation === 'tool_result' ? 'completed' : 'claimed',
                claimId: endpoint.body.requestId,
                ...(endpoint.body.operation === 'tool_result'
                  ? { result: endpoint.body.toolResult }
                  : {}),
              })),
            }),
    );
    render(
      <PetWorkTools
        client={client as unknown as NixClient}
        runtime={validationRuntime}
        workspaceId="11111111-1111-4111-8111-111111111111"
        petId="22222222-2222-4222-8222-222222222222"
        mode="consult"
        onChange={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(client.execute).toHaveBeenCalledTimes(1);
    });
    // UX fix U3 / nit: the read sentence carries the per-operation wording now, with no
    // "(no workspace access)" qualifier.
    expect(screen.getByText('Checking the design')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Approve request' })).not.toBeInTheDocument();
    expect(client.query).not.toHaveBeenCalled();
    expect(finishValidation).toBeTypeOf('function');
    if (finishValidation) finishValidation();
    await waitFor(() => {
      expect(client.execute).toHaveBeenCalledTimes(2);
    });
    expect(runWorkspaceToolSpy).toHaveBeenCalledOnce();
    await expect(
      runWorkspaceToolSpy.mock.results[0]?.value as Promise<unknown>,
    ).resolves.toMatchObject({
      text: expect.stringContaining('"ok":true') as unknown,
      readOnly: true,
      touchedParents: [],
    });
  });

  it('announces blueprint step progress and stores only outcome counts in the receipt', async () => {
    const buildId = '33333333-3333-4333-8333-333333333333';
    const buildRuntime = {
      ...runtime,
      tools: (runtime.tools ?? []).map((tool) => ({
        ...tool,
        arguments: JSON.stringify({
          operation: 'build_blueprint',
          itemId: '',
          parentId: '',
          title: '',
          markdown: '',
          query: '',
          propertiesJson: '',
          specJson: JSON.stringify({
            version: 1,
            title: 'Private title',
            summary: 'A small design.',
            root: { id: 'private-node', title: 'Private title' },
          }),
        }),
      })),
    };
    const fakeClient = {
      query: vi.fn((endpoint: { path?: string }) => {
        if (endpoint.path === '/items/33333333-3333-4333-8333-333333333333')
          return Promise.resolve({
            id: '33333333-3333-4333-8333-333333333333',
            workspaceId: '11111111-1111-4111-8111-111111111111',
            parentId: null,
            title: 'Pet drafts',
          });
        return Promise.reject(new Error(`Unexpected preview query: ${String(endpoint.path)}`));
      }),
      paginate: vi.fn(() => ({
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          yield* [];
        },
      })),
      execute: vi.fn(
        (endpoint: { body: { operation: string; requestId: string; toolResult?: string } }) =>
          Promise.resolve({
            ...buildRuntime,
            tools: buildRuntime.tools.map((tool) => ({
              ...tool,
              status: endpoint.body.operation === 'tool_result' ? 'completed' : 'claimed',
              claimId: endpoint.body.requestId,
            })),
          }),
      ),
      invalidate: vi.fn(),
    };
    let finishRun: (() => void) | undefined;
    runWorkspaceToolSpy.mockImplementationOnce(async (...callArgs: unknown[]) => {
      const options = callArgs[4] as { onProgress?: (completed: number, total: number) => void };
      options.onProgress?.(1, 2);
      await new Promise<void>((resolve) => {
        finishRun = resolve;
      });
      return {
        text: JSON.stringify({
          rootId: buildId,
          complete: true,
          ledger: [
            { nodeId: 'private-node', step: 'createItem', status: 'done', itemId: buildId },
            { nodeId: '$sandbox', step: 'ensureSandbox', status: 'done' },
          ],
        }),
        readOnly: false,
        touchedParents: [null],
      };
    });
    render(
      <MemoryRouter>
        <PetWorkTools
          client={fakeClient as unknown as NixClient}
          runtime={buildRuntime}
          workspaceId="11111111-1111-4111-8111-111111111111"
          petId="22222222-2222-4222-8222-222222222222"
          mode="consult"
          onChange={vi.fn()}
        />
      </MemoryRouter>,
    );
    const approveButton = await screen.findByRole('button', { name: 'Approve request' });
    await waitFor(() => {
      expect(approveButton).toBeEnabled();
    });
    await userEvent.click(approveButton);
    await waitFor(() => {
      expect(runWorkspaceToolSpy).toHaveBeenCalledOnce();
    });
    expect(await screen.findByText('Building 1 of 2...')).toBeInTheDocument();
    if (finishRun) finishRun();
    await waitFor(() => {
      expect(fakeClient.execute).toHaveBeenCalledTimes(2);
    });
    expect(Object.values(sessionStorage)).not.toContain('Private title');
    const storedReceipts = Object.keys(sessionStorage).map((key) => sessionStorage.getItem(key));
    expect(storedReceipts).toContain('Built 2 of 2.');
    expect(storedReceipts.join(' ')).not.toContain('Private title');
  });

  it('offers confirmed cleanup for an incomplete blueprint result', async () => {
    const buildId = '33333333-3333-4333-8333-333333333333';
    const incompleteRuntime = {
      ...runtime,
      tools: (runtime.tools ?? []).map((tool) => ({
        ...tool,
        status: 'completed' as const,
        arguments: JSON.stringify({
          operation: 'build_blueprint',
          itemId: '',
          parentId: '',
          title: '',
          markdown: '',
          query: '',
          propertiesJson: '',
          specJson: JSON.stringify({
            version: 1,
            title: 'Plan',
            summary: 'A small design.',
            root: { id: 'plan', title: 'Plan' },
          }),
        }),
        result: JSON.stringify({
          rootId: buildId,
          complete: false,
          ledger: [
            { nodeId: 'plan', status: 'done' },
            { nodeId: 'task', status: 'failed' },
          ],
        }),
      })),
    };
    client.query.mockResolvedValue({
      id: buildId,
      workspaceId: '11111111-1111-4111-8111-111111111111',
      parentId: null,
      title: 'Plan',
    });
    client.execute.mockResolvedValue(incompleteRuntime);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(
      <MemoryRouter>
        <PetWorkTools
          client={client as unknown as NixClient}
          runtime={incompleteRuntime}
          workspaceId="11111111-1111-4111-8111-111111111111"
          petId="22222222-2222-4222-8222-222222222222"
          mode="consult"
          onChange={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(
      await screen.findByText('Stopped after 1 of 2. The draft is incomplete.'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Move draft to trash' }));
    await waitFor(() => {
      expect(client.execute).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'items.delete' }),
        expect.anything(),
      );
    });
    expect(confirmSpy).toHaveBeenCalledWith(
      'Move the incomplete draft to Trash? It can be restored later.',
    );
    expect(screen.getByText('Incomplete draft moved to Trash.')).toBeInTheDocument();
    expect(Object.keys(sessionStorage)).toHaveLength(0);
  });

  describe('security fix S1: nothing a pending write would store is hidden or truncated', () => {
    function showWrite(operation: string, specJson: string, overrides: Record<string, string> = {}) {
      return render(
        <PetWorkTools
          client={client as unknown as NixClient}
          runtime={{
            ...runtime,
            tools: (runtime.tools ?? []).map((tool) => ({
              ...tool,
              arguments: JSON.stringify({
                operation,
                title: '',
                markdown: '',
                itemId: '',
                parentId: '',
                query: '',
                propertiesJson: '',
                specJson,
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
    }

    it('shows a create_entries entry body past its 200-character summary length', async () => {
      const body = 'y'.repeat(250);
      showWrite(
        'create_entries',
        JSON.stringify({ entries: [{ title: 'Task one', markdown: body }] }),
        { parentId: '33333333-3333-4333-8333-333333333333' },
      );
      const region = await screen.findByText(body);
      expect(region).toBeVisible();
      expect(body[200]).toBeDefined();
    });

    it('shows an add_fields field help string', async () => {
      const help = 'h'.repeat(190);
      showWrite('add_fields', JSON.stringify({ fields: [{ label: 'Status', type: 'text', help }] }), {
        itemId: '33333333-3333-4333-8333-333333333333',
      });
      expect(await screen.findByText(help)).toBeVisible();
    });

    it('shows a save_as_template description', async () => {
      const description = 'd'.repeat(390);
      showWrite('save_as_template', JSON.stringify({ description }), {
        itemId: '33333333-3333-4333-8333-333333333333',
        title: 'Job hunt',
      });
      expect(await screen.findByText(description)).toBeVisible();
    });

    it('shows an apply_template input value', async () => {
      const value = 'v'.repeat(150);
      showWrite('apply_template', JSON.stringify({ inputs: { start_date: value } }), {
        itemId: '33333333-3333-4333-8333-333333333333',
        title: 'Reading log copy',
      });
      expect(await screen.findByText(value)).toBeVisible();
    });

    it('shows an edit_form confirmation message', async () => {
      const message = 'm'.repeat(250);
      showWrite(
        'edit_form',
        JSON.stringify({
          viewId: 'v1',
          form: {
            pages: [{ title: 'Page 1', blocks: [{ field: 'status' }] }],
            confirmation: { title: 'Done', message },
          },
        }),
        { itemId: '33333333-3333-4333-8333-333333333333' },
      );
      expect(await screen.findByText(message)).toBeVisible();
    });

    it('shows a build_blueprint node body', async () => {
      const body = 'b'.repeat(220);
      showWrite(
        'build_blueprint',
        JSON.stringify({
          version: 1,
          title: 'Design draft',
          summary: 'A small design.',
          root: { id: 'plan', title: 'Plan', markdown: body },
        }),
      );
      expect(await screen.findByText(body)).toBeVisible();
    });
  });

  it('retries a second auto-run read whose first attempt found the claim lock held (security fix S3)', async () => {
    const dualRuntime = {
      ...runtime,
      tools: [
        {
          id: 'read-1',
          arguments: JSON.stringify({
            operation: 'search',
            query: 'alpha',
            title: '',
            markdown: '',
            itemId: '',
            parentId: '',
            propertiesJson: '',
          }),
          status: 'pending' as const,
          result: '',
          claimId: '',
        },
        {
          id: 'read-2',
          arguments: JSON.stringify({
            operation: 'search',
            query: 'beta',
            title: '',
            markdown: '',
            itemId: '',
            parentId: '',
            propertiesJson: '',
          }),
          status: 'pending' as const,
          result: '',
          claimId: '',
        },
      ],
    };
    client.execute.mockImplementation(
      (endpoint: { body: { operation: string; requestId: string; toolId: string } }) =>
        Promise.resolve({
          ...dualRuntime,
          tools: dualRuntime.tools.map((tool) =>
            tool.id === endpoint.body.toolId
              ? {
                  ...tool,
                  status: endpoint.body.operation === 'tool_result' ? 'completed' : 'claimed',
                  claimId: endpoint.body.requestId,
                }
              : tool,
          ),
        }),
    );
    runWorkspaceToolSpy.mockResolvedValue({ text: 'ok', readOnly: true, touchedParents: [] });
    render(
      <PetWorkTools
        client={client as unknown as NixClient}
        runtime={dualRuntime}
        workspaceId="11111111-1111-4111-8111-111111111111"
        petId="22222222-2222-4222-8222-222222222222"
        onChange={vi.fn()}
      />,
      { wrapper: MemoryRouter },
    );
    // Without the fix, the second read's auto-run key is set before its `onResolve` call even
    // returns, so once the first read holds the claim lock, the second is never retried.
    await waitFor(() => {
      expect(runWorkspaceToolSpy).toHaveBeenCalledTimes(2);
    });
  });
});
