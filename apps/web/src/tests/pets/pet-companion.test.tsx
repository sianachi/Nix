import { render, screen, waitFor, within } from '@testing-library/react';
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
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      clear: () => {
        stored.clear();
      },
      getItem: (key: string) => stored.get(key) ?? null,
      removeItem: (key: string) => {
        stored.delete(key);
      },
      setItem: (key: string, value: string) => {
        stored.set(key, value);
      },
    });
    sessionStorage.clear();
    client.execute.mockResolvedValue(connected);
    client.query.mockResolvedValue(connected);
  });

  it('opens upward when a moved companion is near the bottom of the screen', async () => {
    localStorage.setItem('nix.pet.position', JSON.stringify({ x: 24, y: 700 }));
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    const launcher = screen.getByRole('button', { name: 'Talk with Cat' });
    vi.spyOn(launcher, 'getBoundingClientRect').mockReturnValue({
      bottom: 760,
      height: 60,
      left: 24,
      right: 84,
      top: 700,
      width: 60,
      x: 24,
      y: 700,
      toJSON: () => ({}),
    });

    await userEvent.click(launcher);

    const companion = screen.getByRole('complementary', { name: 'Cat companion' });
    expect(companion).toHaveStyle({
      bottom: `${String(window.innerHeight - 760)}px`,
      left: '24px',
    });
    expect(companion.style.top).toBe('');
    expect(screen.getByRole('button', { name: 'Close Cat' })).toHaveClass('hidden');
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

  it('renders a system notice without an author or approval controls', async () => {
    client.execute.mockResolvedValue({
      ...connected,
      messages: [
        {
          id: 'notice',
          role: 'system',
          text: 'Your pet was updated and starts a fresh conversation.',
          actions: [],
        },
      ],
    });
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Talk with Cat' }));
    expect(
      await screen.findByText('Your pet was updated and starts a fresh conversation.'),
    ).toBeVisible();
    const log = within(screen.getByRole('log', { name: 'Conversation messages' }));
    expect(log.queryByText('You')).not.toBeInTheDocument();
    expect(log.queryByText('Cat')).not.toBeInTheDocument();
    expect(log.queryByRole('button', { name: 'Read aloud' })).not.toBeInTheDocument();
    expect(log.queryByRole('button', { name: 'Approve change' })).not.toBeInTheDocument();
  });

  it('approval state derives only from pending tool calls', async () => {
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
      tools: [],
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Talk with Cat' }));
    await screen.findByText('I can create this note.');
    expect(screen.queryByRole('button', { name: 'Approve change' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).not.toHaveTextContent('Needs approval');

    client.execute.mockResolvedValue({
      ...connected,
      messages: [
        {
          id: 'message-one',
          role: 'assistant',
          text: 'I can create this note.',
          actions: [],
        },
      ],
      tools: [
        {
          id: 'tool-one',
          arguments: '{}',
          status: 'pending',
          result: '',
          claimId: '',
        },
      ],
    });
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Needs approval')).toBeVisible();
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
