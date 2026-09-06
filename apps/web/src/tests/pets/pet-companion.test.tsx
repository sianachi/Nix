import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { PetCompanion } from '../../pets/pet-companion';
import { PetConnectionPanel } from '../../pets/pet-connection-panel';

const client = vi.hoisted(() => ({ execute: vi.fn(), query: vi.fn() }));
vi.mock('../../api/api-client-provider', () => ({ useApiClient: () => client }));
vi.mock('../../workspaces/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: '33333333-3333-4333-8333-333333333333' }),
}));
vi.mock('../../pets/use-pet-settings', () => ({
  usePetSettings: () => ({
    saved: {
      revision: 1,
      settings: {
        enabled: true,
        activePetId: '44444444-4444-4444-8444-444444444444',
        motion: 'reduced',
        narration: false,
        profiles: [
          {
            id: '44444444-4444-4444-8444-444444444444',
            name: 'Cat',
            appearance: 'cat',
            personality: 'calm',
            responseLength: 'balanced',
            instructions: '',
          },
        ],
      },
    },
  }),
}));

const connected = {
  provider: 'chatgpt',
  status: 'connected',
  reason: 'Connected',
  canConnect: false,
  state: 'success',
  messages: [],
  verificationUrl: '',
  userCode: '',
};

describe('companion workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    client.execute.mockResolvedValue(connected);
    client.query.mockResolvedValue(connected);
  });

  it('sends only explicitly entered text and scopes the conversation', async () => {
    const user = userEvent.setup();
    const view = render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    expect(client.execute).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Talk with Cat' }));
    await screen.findByRole('dialog', { name: 'Conversation with Cat' });
    await user.type(screen.getByRole('textbox', { name: 'Message Cat' }), 'Help with a plan');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(client.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            operation: 'send',
            text: 'Help with a plan',
            workspaceId: '33333333-3333-4333-8333-333333333333',
          }) as unknown,
        }),
        expect.anything(),
      );
    });
    const call = client.execute.mock.calls.find(
      ([endpoint]) => (endpoint as { body?: { operation?: string } }).body?.operation === 'send',
    );
    expect(call?.[0]).toMatchObject({
      body: { sharedText: '' },
    });
    view.unmount();
  });

  it('prioritises replies and keeps secondary controls collapsed', async () => {
    client.execute.mockResolvedValue({
      ...connected,
      messages: [
        {
          id: 'visible-reply',
          role: 'assistant',
          text: 'Your reply stays in the reading area.',
          actions: [],
        },
      ],
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Talk with Cat' }));
    expect(await screen.findByText('Your reply stays in the reading area.')).toBeVisible();
    const messages = screen.getByRole('log', { name: 'Conversation messages' });
    expect(messages).not.toContainElement(screen.getByRole('textbox', { name: 'Message Cat' }));
    expect(screen.getByRole('combobox', { name: 'Codex model' })).not.toBeVisible();
    expect(screen.getByRole('button', { name: 'New conversation' })).not.toBeVisible();
    await user.click(screen.getByText('Chat options and connection'));
    expect(screen.getByRole('combobox', { name: 'Codex model' })).toBeVisible();
    await user.click(screen.getByText('More actions and history'));
    expect(screen.getByRole('button', { name: 'New conversation' })).toBeVisible();
  });

  it('keeps the chosen model when the chat is closed and reopened', async () => {
    client.execute.mockResolvedValue({
      ...connected,
      models: [{ id: 'gpt-5.3-codex-spark', name: 'GPT-5.3-Codex-Spark', default: false }],
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Talk with Cat' }));
    await user.click(screen.getByText('Chat options and connection'));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Codex model' }),
      'gpt-5.3-codex-spark',
    );
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.click(screen.getByRole('button', { name: 'Talk with Cat' }));
    await user.click(screen.getByText('Chat options and connection'));
    expect(screen.getByRole('combobox', { name: 'Codex model' })).toHaveValue(
      'gpt-5.3-codex-spark',
    );
  });

  it('shows response failures without requiring users to open chat options', async () => {
    client.execute.mockResolvedValue({
      ...connected,
      state: 'error',
      reason: 'The response could not finish.',
    });
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Talk with Cat' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The response could not finish.');
    expect(screen.getByRole('alert')).toBeVisible();
  });

  it('never executes a proposal until approved and remembers the receipt when reopened', async () => {
    client.execute.mockResolvedValue({
      ...connected,
      messages: [
        {
          id: 'message-one',
          role: 'assistant',
          text: 'I can create this note.',
          actions: [{ kind: 'create_item', itemId: '', title: 'Plan' }],
        },
      ],
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Talk with Cat' }));
    await screen.findByRole('button', { name: 'Approve change' });
    expect(client.execute).not.toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'items.create' }),
      expect.anything(),
    );
    await user.click(screen.getByRole('button', { name: 'Approve change' }));
    await screen.findByText('Applied');
    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'items.create',
        body: expect.objectContaining({ title: 'Plan' }) as unknown,
      }),
      expect.anything(),
    );
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.click(screen.getByRole('button', { name: 'Talk with Cat' }));
    await screen.findByText('Applied');
    expect(screen.queryByRole('button', { name: 'Approve change' })).not.toBeInTheDocument();
  });

  it('rejects a rename outside the active workspace', async () => {
    client.execute.mockResolvedValue({
      ...connected,
      messages: [
        {
          id: 'message-two',
          role: 'assistant',
          text: 'Rename?',
          actions: [{ kind: 'rename_item', itemId: 'other-item', title: 'Changed' }],
        },
      ],
    });
    client.query.mockResolvedValue({ workspaceId: 'another-workspace' });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Talk with Cat' }));
    await user.click(await screen.findByRole('button', { name: 'Approve change' }));
    await screen.findByText(/Not confirmed/);
    expect(client.execute).not.toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'items.rename' }),
      expect.anything(),
    );
  });

  it('offers device sign-in and cancellation without handling credentials in the browser', async () => {
    client.query.mockResolvedValue({ ...connected, status: 'disconnected', canConnect: true });
    client.execute.mockResolvedValue({
      ...connected,
      status: 'connecting',
      canConnect: true,
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'TEST-CODE',
    });
    const user = userEvent.setup();
    render(<PetConnectionPanel />);
    const button = await screen.findByRole('button', { name: 'Connect ChatGPT' });
    await waitFor(() => {
      expect(button).toBeEnabled();
    });
    await user.click(button);
    expect(await screen.findByRole('link', { name: 'Open ChatGPT sign-in' })).toHaveAttribute(
      'href',
      'https://auth.openai.com/codex/device',
    );
    await user.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          operation: 'disconnect',
          text: '',
          sharedText: '',
        }) as unknown,
      }),
      expect.anything(),
    );
  });
});
