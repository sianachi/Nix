import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../app';
import { item, STUB_WORKSPACE, stubCoreApi, type StubWorkspace } from '../api-stub';
import { renderAt, signedIn } from '../render-with-router';

const SHARED_ID = '00000000-0000-4000-8000-000000000002';
const INACCESSIBLE_ID = '00000000-0000-4000-8000-000000000099';
const NOTE = item({
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Scoped note',
});

const SHARED: StubWorkspace = {
  ...STUB_WORKSPACE,
  id: SHARED_ID,
  name: 'Shared research',
  kind: 'shared',
  canLeave: true,
};

function memoryStorage(initial: Readonly<Record<string, string>> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear: () => {
      values.clear();
    },
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

beforeEach(() => {
  signedIn();
  vi.stubGlobal('localStorage', memoryStorage());
});

describe('workspace-scoped routing', () => {
  it('opens the personal workspace from a legacy route when no accessible workspace was remembered', async () => {
    stubCoreApi({ workspaces: [SHARED, STUB_WORKSPACE] });
    renderAt(<App />, '/graph');

    expect(await screen.findByRole('heading', { name: 'Graph' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Workspace' })).toHaveValue(STUB_WORKSPACE.id);
    expect(screen.getByRole('link', { name: 'Graph' })).toHaveAttribute(
      'href',
      `/w/${STUB_WORKSPACE.id}/graph`,
    );
    expect(workspaceListRequests()).toHaveLength(1);
  });

  it('uses an accessible remembered workspace but ignores an opaque id the caller cannot reach', async () => {
    vi.stubGlobal('localStorage', memoryStorage({ 'nix.last-workspace-id': SHARED_ID }));
    stubCoreApi({ workspaces: [STUB_WORKSPACE, SHARED] });
    const first = renderAt(<App />, '/calendar');
    expect(await screen.findByRole('heading', { name: 'Calendar' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Workspace' })).toHaveValue(SHARED_ID);
    first.unmount();

    vi.stubGlobal('localStorage', memoryStorage({ 'nix.last-workspace-id': INACCESSIBLE_ID }));
    renderAt(<App />, '/calendar');
    expect(await screen.findByRole('heading', { name: 'Calendar' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Workspace' })).toHaveValue(STUB_WORKSPACE.id);
  });

  it('opens an accessible deep link without passing through the legacy resolver', async () => {
    stubCoreApi({ workspaces: [STUB_WORKSPACE, SHARED] });
    renderAt(<App />, `/w/${SHARED_ID}/graph`);

    expect(await screen.findByRole('heading', { name: 'Graph' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Workspace' })).toHaveValue(SHARED_ID);
  });

  it('does not confirm whether an inaccessible workspace exists', async () => {
    stubCoreApi({ workspaces: [STUB_WORKSPACE] });
    renderAt(<App />, `/w/${INACCESSIBLE_ID}`);

    expect(await screen.findByRole('heading', { name: 'Workspace not found' })).toBeVisible();
    expect(screen.getByText(/unavailable or you do not have access/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Switch workspace' })).toBeVisible();
    expect(screen.queryByRole('combobox', { name: 'Workspace' })).not.toBeInTheDocument();
  });

  it('does not call a workspace missing when the accessible list is partial', async () => {
    stubCoreApi({ workspaces: [STUB_WORKSPACE, SHARED], workspacesPartial: true });
    renderAt(<App />, `/w/${SHARED.id}`);

    expect(
      await screen.findByRole('heading', { name: 'Workspace access could not be checked' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Workspace not found' })).not.toBeInTheDocument();
  });

  it('clears item and pane state when switching and reloads against the target workspace', async () => {
    const user = userEvent.setup();
    stubCoreApi({ workspaces: [STUB_WORKSPACE, SHARED], items: [NOTE] });
    renderAt(<App />, `/w/${STUB_WORKSPACE.id}?item=${NOTE.id}&view=board&item2=${NOTE.id}`);

    const selected = await screen.findByRole('treeitem', { name: 'Scoped note' });
    expect(selected).toHaveAttribute('aria-selected', 'true');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Workspace' }), SHARED_ID);

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Workspace' })).toHaveValue(SHARED_ID);
      expect(screen.getByRole('treeitem', { name: 'Scoped note' })).toHaveAttribute(
        'aria-selected',
        'false',
      );
    });
    expect(screen.getByRole('link', { name: 'Notes' })).toHaveAttribute('href', `/w/${SHARED_ID}`);
  });

  it('renders honest empty and error states before mounting workspace resources', async () => {
    stubCoreApi({ workspaces: [] });
    const empty = renderAt(<App />);
    expect(await screen.findByRole('heading', { name: 'No workspace is available' })).toBeVisible();
    empty.unmount();

    stubCoreApi({ workspacesFail: true });
    renderAt(<App />);
    expect(
      await screen.findByRole('heading', { name: 'Your workspaces could not be loaded' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});

function workspaceListRequests(): readonly unknown[] {
  return (
    fetch as unknown as { mock: { calls: [RequestInfo | URL, RequestInit | undefined][] } }
  ).mock.calls.filter(([input, init]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    return method === 'GET' && new URL(url, location.origin).pathname === '/api/v1/workspaces';
  });
}
