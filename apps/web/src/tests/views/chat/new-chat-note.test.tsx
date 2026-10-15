import { createNixClient, type NixClient } from '@nix/api-client';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import { z } from 'zod';
import { ApiClientOverrideProvider } from '../../../api/api-client-provider';
import { AccessibleWorkspacesProvider } from '../../../workspaces/workspace-context';
import { NewChatNote } from '../../../views/chat/new-chat-note';
import { STUB_WORKSPACE } from '../../api-stub';

const id = '11111111-1111-4111-8111-111111111111';
describe('new chat notes', () => {
  it('retries the first prompt in the saved conversation with the same request identity', async () => {
    const user = userEvent.setup();
    let creates = 0;
    const requests: string[] = [];
    const chat = {
      itemId: id,
      workspaceId: STUB_WORKSPACE.id,
      title: 'Compare priorities',
      sourceWorkspaceIds: [STUB_WORKSPACE.id],
      petId: id,
      revision: 1,
      canSend: true,
      canEdit: true,
      turn: null,
    };
    const base = createNixClient({
      baseUrl: 'http://nix.invalid',
      tokens: {
        getAccessToken: () => Promise.resolve(null),
        refreshAccessToken: () => Promise.resolve(null),
      },
    });
    const client: NixClient = {
      ...base,
      query: (endpoint) =>
        Promise.resolve(
          endpoint.schema.parse(
            endpoint.operation === 'pets.settings'
              ? {
                  revision: 1,
                  settings: {
                    enabled: true,
                    activePetId: id,
                    motion: 'system',
                    profiles: [
                      {
                        id,
                        name: 'Owl',
                        appearance: 'owl',
                        personality: 'calm',
                        responseLength: 'balanced',
                        instructions: '',
                      },
                    ],
                  },
                }
              : { revision: 0, groups: [], pinnedWorkspaceIds: [] },
          ),
        ),
      paginate: async function* (endpoint) {
        if (endpoint.operation === 'workspaces.list')
          yield await Promise.resolve(endpoint.itemSchema.parse(STUB_WORKSPACE));
      },
      execute: (endpoint) => {
        if (endpoint.operation === 'conversations.create') {
          creates++;
          return Promise.resolve(endpoint.schema.parse(chat));
        }
        const body = z.object({ requestId: z.uuid() }).parse(endpoint.body);
        requests.push(body.requestId);
        return requests.length === 1
          ? Promise.reject(new Error('Response lost'))
          : Promise.resolve(endpoint.schema.parse(chat));
      },
    };
    render(
      <ApiClientOverrideProvider client={client}>
        <MemoryRouter>
          <Routes>
            <Route element={<AccessibleWorkspacesProvider />}>
              <Route
                path="*"
                element={
                  <NewChatNote
                    sourceWorkspaceIds={[STUB_WORKSPACE.id]}
                    initialPrompt="Compare priorities"
                    onClose={() => undefined}
                  />
                }
              />
            </Route>
          </Routes>
        </MemoryRouter>
      </ApiClientOverrideProvider>,
    );
    await screen.findByRole('option', { name: STUB_WORKSPACE.name });
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Destination workspace' }),
      STUB_WORKSPACE.id,
    );
    await user.click(
      screen.getByRole('checkbox', { name: 'I confirm this destination and its sharing' }),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Create chat note' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: 'Create chat note' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The chat was saved');
    await user.click(screen.getByRole('button', { name: 'Retry first message' }));
    await waitFor(() => {
      expect(requests).toHaveLength(2);
    });
    expect(creates).toBe(1);
    expect(requests[0]).toBe(requests[1]);
  });
  it('configures the existing note without asking for a replacement destination', async () => {
    const user = userEvent.setup();
    const operations: string[] = [];
    const paths: string[] = [];
    const chat = {
      itemId: id,
      workspaceId: STUB_WORKSPACE.id,
      title: 'Existing note',
      sourceWorkspaceIds: [STUB_WORKSPACE.id],
      petId: id,
      revision: 1,
      canSend: true,
      canEdit: true,
      turn: null,
    };
    const base = createNixClient({
      baseUrl: 'http://nix.invalid',
      tokens: {
        getAccessToken: () => Promise.resolve(null),
        refreshAccessToken: () => Promise.resolve(null),
      },
    });
    const client: NixClient = {
      ...base,
      query: (endpoint) =>
        Promise.resolve(
          endpoint.schema.parse(
            endpoint.operation === 'pets.settings'
              ? {
                  revision: 1,
                  settings: {
                    enabled: true,
                    activePetId: id,
                    motion: 'system',
                    profiles: [
                      {
                        id,
                        name: 'Owl',
                        appearance: 'owl',
                        personality: 'calm',
                        responseLength: 'balanced',
                        instructions: '',
                      },
                    ],
                  },
                }
              : { revision: 0, groups: [], pinnedWorkspaceIds: [] },
          ),
        ),
      paginate: async function* (endpoint) {
        if (endpoint.operation === 'workspaces.list')
          yield await Promise.resolve(endpoint.itemSchema.parse(STUB_WORKSPACE));
      },
      execute: (endpoint) => {
        operations.push(endpoint.operation);
        paths.push(endpoint.path);
        return Promise.resolve(endpoint.schema.parse(chat));
      },
    };
    render(
      <ApiClientOverrideProvider client={client}>
        <MemoryRouter>
          <Routes>
            <Route element={<AccessibleWorkspacesProvider />}>
              <Route
                path="*"
                element={
                  <NewChatNote
                    existingItemId={id}
                    sourceWorkspaceIds={[STUB_WORKSPACE.id]}
                    onClose={() => undefined}
                  />
                }
              />
            </Route>
          </Routes>
        </MemoryRouter>
      </ApiClientOverrideProvider>,
    );
    await screen.findByRole('option', { name: 'Owl' });
    expect(
      screen.queryByRole('combobox', { name: 'Destination workspace' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('combobox', { name: 'Destination parent note' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByRole('checkbox', { name: 'I confirm this destination and its sharing' }),
    ).toHaveLength(1);
    await user.click(
      screen.getByRole('checkbox', { name: 'I confirm this destination and its sharing' }),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Set up chat' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Set up chat' }));
    await waitFor(() => {
      expect(operations).toEqual(['conversations.configure']);
    });
    expect(paths).toEqual([`/api/v1/conversations/${id}/configure`]);
  });
});
