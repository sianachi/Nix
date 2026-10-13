import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PetPage } from '../../pages/pet-page';

const WORKSPACE = '33333333-3333-4333-8333-333333333333';
const ROOT = '66666666-6666-4666-8666-666666666666';
const mock = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn(), send: vi.fn(), hook: vi.fn() }));
vi.mock('../../api/api-client-provider', () => ({ useApiClient: () => mock }));
vi.mock('../../workspaces/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: WORKSPACE }),
}));
vi.mock('../../pets/use-pet-settings', () => ({
  usePetSettings: () => ({
    saved: {
      settings: {
        enabled: true,
        activePetId: '44444444-4444-4444-8444-444444444444',
        motion: 'reduced',
        profiles: [
          {
            id: '44444444-4444-4444-8444-444444444444',
            name: 'Pip',
            appearance: 'cat',
            personality: 'calm',
            responseLength: 'balanced',
            instructions: '',
            applyWithoutAsking: false,
            provider: 'chatgpt',
          },
        ],
      },
    },
  }),
}));
vi.mock('../../pets/use-pet-runtime', () => ({
  usePetRuntime: (...args: unknown[]) => {
    mock.hook(...args);
    return {
      runtime: { status: 'connected', state: 'idle', messages: [], tools: [], lockedRead: false },
      models: [],
      busy: false,
      error: '',
      errorKind: null,
      send: mock.send,
      setRuntime: vi.fn(),
      regenerateRequestId: vi.fn(),
      interrupt: vi.fn(),
      reset: vi.fn(),
      reload: vi.fn(),
      retryWatch: vi.fn(),
    };
  },
}));

function renderNote(root = ROOT) {
  return render(
    <MemoryRouter initialEntries={[`/w/${WORKSPACE}/pet?root=${root}`]}>
      <PetPage />
    </MemoryRouter>,
  );
}

describe('note chat page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.send.mockResolvedValue(true);
    mock.query.mockImplementation((endpoint: { operation: string }) =>
      Promise.resolve(
        endpoint.operation === 'locks.get'
          ? { locked: false, unlockedUntil: null }
          : { id: ROOT, workspaceId: WORKSPACE, title: 'Nix documentation', type: 'note' },
      ),
    );
  });

  it('defaults to read-only retrieval for the note and lets the user require approved edits', async () => {
    const user = userEvent.setup();
    renderNote();
    const access = await screen.findByRole('combobox', { name: 'Note chat access' });
    expect(access).toHaveValue('read');
    expect(mock.hook).toHaveBeenLastCalledWith(
      WORKSPACE,
      '44444444-4444-4444-8444-444444444444',
      true,
      ROOT,
    );
    expect(screen.queryByRole('button', { name: 'Workspace access' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply without asking' })).not.toBeInTheDocument();
    expect(screen.getByText(/Search and results can be partial/)).toBeVisible();
    await user.type(
      screen.getByRole('textbox', { name: 'Message Pip' }),
      'Explain this documentation',
    );
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(mock.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ itemId: ROOT, readOnly: true, workspaceAccess: true }),
    );
    expect(mock.send.mock.calls.at(-1)?.[0]).not.toHaveProperty('workspaceMap');
    await user.selectOptions(access, 'edit');
    // An editable note offers the same Apply without asking switch as the workspace chat.
    expect(screen.getByRole('button', { name: 'Apply without asking' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await user.type(screen.getByRole('textbox', { name: 'Message Pip' }), 'Append a summary');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(mock.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ itemId: ROOT, readOnly: false }),
    );
  });

  it('refuses unavailable or locked roots before opening their conversation', async () => {
    mock.query.mockImplementation((endpoint: { operation: string }) =>
      Promise.resolve(
        endpoint.operation === 'locks.get'
          ? { locked: true, unlockedUntil: null }
          : { id: ROOT, workspaceId: WORKSPACE, title: 'Private note', type: 'note' },
      ),
    );
    renderNote();
    expect(await screen.findByText('This note is unavailable')).toBeVisible();
    expect(mock.hook).not.toHaveBeenCalled();
  });

  it('loads archived history only for the note conversation', async () => {
    mock.execute.mockResolvedValue({ history: [] });
    const user = userEvent.setup();
    renderNote();
    await screen.findByRole('combobox', { name: 'Note chat access' });
    await user.click(screen.getByRole('button', { name: 'More conversation actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Past conversations' }));
    await user.click(screen.getByRole('button', { name: 'Conversation history' }));
    await waitFor(() => {
      const request: unknown = mock.execute.mock.calls.at(-1)?.[0];
      expect(request).toHaveProperty('body.operation', 'history');
      expect(request).toHaveProperty('body.rootItemId', ROOT);
    });
  });
});
