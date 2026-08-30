import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../app';
import { STUB_WORKSPACE, stubCoreApi, type StubMember, type StubWorkspace } from '../api-stub';
import { renderAt, signedIn } from '../render-with-router';

const OWNER_ID = '44444444-bbbb-4bbb-8bbb-444444444444';
const EDITOR_ID = '55555555-bbbb-4bbb-8bbb-555555555555';
const members: readonly StubMember[] = [
  {
    subjectType: 'principal',
    subjectId: OWNER_ID,
    subjectDisplayName: 'Protected owner',
    role: 'owner',
    grantedAt: '2026-01-05T09:00:00+00:00',
    canChangeRole: false,
    canRemove: false,
    assignableRoles: [],
  },
  {
    subjectType: 'principal',
    subjectId: EDITOR_ID,
    subjectDisplayName: 'Working editor',
    role: 'editor',
    grantedAt: '2026-03-12T09:00:00+00:00',
    canChangeRole: true,
    canRemove: true,
    assignableRoles: ['editor', 'viewer'],
  },
];
const EDITOR_MEMBER: StubMember = {
  subjectType: 'principal',
  subjectId: EDITOR_ID,
  subjectDisplayName: 'Working editor',
  role: 'editor',
  grantedAt: '2026-03-12T09:00:00+00:00',
  canChangeRole: true,
  canRemove: true,
  assignableRoles: ['editor', 'viewer'],
};

const SHARED: StubWorkspace = {
  ...STUB_WORKSPACE,
  id: '00000000-0000-4000-8000-000000000002',
  name: 'Shared research',
  kind: 'shared',
  canLeave: true,
};

beforeEach(() => {
  signedIn();
});

describe('workspace management', () => {
  it('uses server-decided row capabilities for protected owner controls', async () => {
    stubCoreApi({ members });
    renderAt(<App />, '/settings');

    const protectedRole = await screen.findByRole('combobox', { name: 'Role for Protected owner' });
    expect(protectedRole).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: 'Remove Protected owner' }),
    ).not.toBeInTheDocument();

    const editorRole = screen.getByRole('combobox', { name: 'Role for Working editor' });
    expect(editorRole).toBeEnabled();
    expect(within(editorRole).queryByRole('option', { name: 'Owner' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Working editor' })).toBeEnabled();
  });

  it('creates an out-of-band pending invitation and keeps its history visible', async () => {
    const user = userEvent.setup();
    stubCoreApi({ members });
    renderAt(<App />, '/settings');

    await screen.findByText(/No email is sent/i);
    await user.type(
      screen.getByRole('textbox', { name: 'Email address' }),
      'New.Person@Example.COM',
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'Role' }), 'viewer');
    await user.click(screen.getByRole('button', { name: 'Invite' }));

    await waitFor(() => {
      expect(
        fetchCalls().filter((call) => call.method === 'POST' && call.url.endsWith('/invitations')),
      ).toHaveLength(1);
      expect(
        fetchCalls().filter((call) => call.method === 'GET' && call.url.includes('/invitations'))
          .length,
      ).toBeGreaterThan(1);
    });
    expect(await screen.findByText('new.person@example.com')).toBeVisible();
    expect(screen.getByText('pending')).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Revoke invitation for new.person@example.com' }),
    ).toBeVisible();
  });

  it('does not offer owner for a personal-workspace invitation', async () => {
    stubCoreApi();
    renderAt(<App />, '/settings');

    const role = await screen.findByRole('combobox', { name: 'Role' });
    expect(within(role).queryByRole('option', { name: 'Owner' })).not.toBeInTheDocument();
    expect(within(role).getByRole('option', { name: 'Editor' })).toBeInTheDocument();
    expect(within(role).getByRole('option', { name: 'Viewer' })).toBeInTheDocument();
  });

  it('creates a shared workspace and opens it', async () => {
    const user = userEvent.setup();
    stubCoreApi();
    renderAt(<App />, '/settings');

    await user.type(
      await screen.findByRole('textbox', { name: 'New workspace name' }),
      'Project Atlas',
    );
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(
        fetchCalls().filter(
          (call) => call.method === 'POST' && call.url.endsWith('/api/v1/workspaces'),
        ),
      ).toHaveLength(1);
      expect(screen.getByRole('combobox', { name: 'Workspace' })).toHaveDisplayValue(
        'Project Atlas',
      );
    });
  });

  it('leaves a shared workspace and returns to an accessible workspace', async () => {
    const user = userEvent.setup();
    stubCoreApi({ workspaces: [STUB_WORKSPACE, SHARED] });
    renderAt(<App />, `/w/${SHARED.id}/settings`);

    await user.click(await screen.findByRole('button', { name: 'Leave workspace' }));
    const confirmation = await screen.findByRole('dialog', { name: 'Leave workspace?' });
    await user.click(within(confirmation).getByRole('button', { name: 'Leave workspace' }));

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Workspace' })).toHaveValue(STUB_WORKSPACE.id);
    });
    expect(
      within(screen.getByRole('combobox', { name: 'Workspace' })).queryByRole('option', {
        name: SHARED.name,
      }),
    ).not.toBeInTheDocument();
  });

  it('keeps a failed leave confirmation open, focused and announced', async () => {
    const user = userEvent.setup();
    stubCoreApi({ workspaces: [STUB_WORKSPACE, SHARED], leaveFails: true });
    renderAt(<App />, `/w/${SHARED.id}/settings`);

    await user.click(await screen.findByRole('button', { name: 'Leave workspace' }));
    const dialog = await screen.findByRole('dialog', { name: 'Leave workspace?' });
    const leave = within(dialog).getByRole('button', { name: 'Leave workspace' });
    leave.focus();
    await user.click(leave);

    expect(dialog).toBeVisible();
    expect(leave).toHaveFocus();
    expect(await screen.findByRole('alert')).toHaveTextContent('The workspace could not be left.');
    expect(screen.getByRole('combobox', { name: 'Workspace' })).toHaveValue(SHARED.id);
  });

  it('renders a permission-filtered workspace without management controls', async () => {
    stubCoreApi({
      workspaces: [{ ...STUB_WORKSPACE, canManageMembers: false, canRename: false }],
    });
    renderAt(<App />, '/settings');

    expect(await screen.findByText(/cannot manage its members/i)).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Workspace name' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Email address' })).not.toBeInTheDocument();
  });

  it('keeps member and invitation failures independent', async () => {
    stubCoreApi({ members, invitationsFail: true });
    renderAt(<App />, '/settings');

    expect(await screen.findByText('Working editor')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Invitations could not be loaded' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(screen.queryByText('No invitation history yet.')).not.toBeInTheDocument();
  });

  it('shows a legacy commenter without offering that role as a new assignment', async () => {
    stubCoreApi({
      members: [
        {
          ...EDITOR_MEMBER,
          subjectDisplayName: 'Legacy commenter',
          role: 'commenter',
          assignableRoles: ['editor', 'viewer'],
        },
      ],
    });
    renderAt(<App />, '/settings');

    const role = await screen.findByRole('combobox', { name: 'Role for Legacy commenter' });
    expect(within(role).getByRole('option', { name: 'Commenter (legacy)' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Role' })).not.toContainHTML('commenter');
  });

  it('remounts workspace-owned form, notice and confirmation state on a switch', async () => {
    const user = userEvent.setup();
    stubCoreApi({ workspaces: [STUB_WORKSPACE, SHARED], members });
    renderAt(<App />, '/settings');

    const rename = await screen.findByRole('textbox', { name: 'Workspace name' });
    await user.clear(rename);
    await user.type(rename, 'Unsaved personal name');
    await user.type(screen.getByRole('textbox', { name: 'Email address' }), 'invite@example.com');
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    expect(await screen.findByText('Invitation created for invite@example.com.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Remove Working editor' }));
    expect(await screen.findByRole('dialog', { name: 'Remove Working editor?' })).toBeVisible();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Workspace' }), SHARED.id);

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Workspace' })).toHaveValue(SHARED.id);
    });
    expect(
      screen.queryByRole('dialog', { name: 'Remove Working editor?' }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Settings' }));
    expect(await screen.findByRole('textbox', { name: 'Workspace name' })).toHaveValue(SHARED.name);
    expect(screen.getByRole('textbox', { name: 'Email address' })).toHaveValue('');
    expect(
      screen.queryByText('Invitation created for invite@example.com.'),
    ).not.toBeInTheDocument();
  });

  it('keeps a failed removal confirmation open and reports the refusal live', async () => {
    const user = userEvent.setup();
    stubCoreApi({ members, memberMutationFails: true });
    renderAt(<App />, '/settings');

    await user.click(await screen.findByRole('button', { name: 'Remove Working editor' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove Working editor?' });
    await user.click(within(dialog).getByRole('button', { name: 'Remove member' }));

    expect(dialog).toBeVisible();
    expect(await screen.findByRole('alert')).toHaveTextContent('The member could not be removed.');
  });

  it('keeps the incomplete-list warning after locally creating a workspace', async () => {
    const user = userEvent.setup();
    stubCoreApi({ workspaces: [STUB_WORKSPACE, SHARED], workspacesPartial: true });
    renderAt(<App />, '/settings');

    await waitFor(() => {
      expect(document.body).toHaveTextContent(/list may be incomplete/i);
    });
    await user.type(screen.getByRole('textbox', { name: 'New workspace name' }), 'Local project');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Workspace' })).toHaveDisplayValue(
        'Local project',
      );
    });
    await waitFor(() => {
      expect(document.body).toHaveTextContent(/list may be incomplete/i);
    });
  });

  it('does not let a delayed workspace refresh erase a workspace created while it was loading', async () => {
    const user = userEvent.setup();
    stubCoreApi();
    const fallbackFetch = fetch;
    let listRequests = 0;
    const refresh = { finish: null as ((response: Response) => void) | null };
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : null;
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
        if (method === 'GET' && new URL(url, location.origin).pathname === '/api/v1/workspaces') {
          listRequests += 1;
          if (listRequests === 2) {
            return new Promise<Response>((resolve) => {
              refresh.finish = resolve;
            });
          }
        }
        return fallbackFetch(input, init);
      }),
    );
    renderAt(<App />, '/settings');

    const rename = await screen.findByRole('textbox', { name: 'Workspace name' });
    await user.clear(rename);
    await user.type(rename, 'Renamed personal workspace');
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => {
      expect(refresh.finish).not.toBeNull();
    });

    await user.type(
      screen.getByRole('textbox', { name: 'New workspace name' }),
      'New local project',
    );
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Workspace' })).toHaveDisplayValue(
        'New local project',
      );
    });

    refresh.finish?.(
      new Response(JSON.stringify({ items: [STUB_WORKSPACE], nextCursor: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Workspace' })).toHaveDisplayValue(
        'New local project',
      );
    });
  });

  it('keeps a stale list behind a local rename, then accepts a later authoritative name and capability', async () => {
    const user = userEvent.setup();
    stubCoreApi({ workspaces: [STUB_WORKSPACE, SHARED] });
    const fallbackFetch = fetch;
    let listRequests = 0;
    const deferred = new Map<number, (response: Response) => void>();
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : null;
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
        if (method === 'GET' && new URL(url, location.origin).pathname === '/api/v1/workspaces') {
          listRequests += 1;
          if (listRequests === 2 || listRequests === 3) {
            return new Promise<Response>((resolve) => {
              deferred.set(listRequests, resolve);
            });
          }
        }
        return fallbackFetch(input, init);
      }),
    );
    renderAt(<App />, '/settings');

    const rename = await screen.findByRole('textbox', { name: 'Workspace name' });
    await user.clear(rename);
    await user.type(rename, 'Locally renamed');
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => {
      expect(deferred.has(2)).toBe(true);
    });
    deferred.get(2)?.(
      new Response(JSON.stringify({ items: [STUB_WORKSPACE, SHARED], nextCursor: null }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Workspace' })).toHaveDisplayValue(
        'Locally renamed',
      );
    });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Workspace' }), SHARED.id);
    await user.click(await screen.findByRole('link', { name: 'Settings' }));
    await user.click(await screen.findByRole('button', { name: 'Leave workspace' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Leave workspace?' })).getByRole('button', {
        name: 'Leave workspace',
      }),
    );
    await waitFor(() => {
      expect(deferred.has(3)).toBe(true);
    });
    deferred.get(3)?.(
      new Response(
        JSON.stringify({
          items: [
            {
              ...STUB_WORKSPACE,
              name: 'Authoritative workspace',
              canRename: false,
              canManageMembers: false,
            },
          ],
          nextCursor: null,
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Workspace' })).toHaveDisplayValue(
        'Authoritative workspace',
      );
    });
    await user.click(screen.getByRole('link', { name: 'Settings' }));
    expect(await screen.findByText(/cannot manage its members/i)).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Workspace name' })).not.toBeInTheDocument();
  });
});

function fetchCalls(): readonly { readonly url: string; readonly method: string }[] {
  return (
    fetch as unknown as { mock: { calls: [RequestInfo | URL, RequestInit | undefined][] } }
  ).mock.calls.map(([input, init]) => ({
    url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    method: (init?.method ?? 'GET').toUpperCase(),
  }));
}
