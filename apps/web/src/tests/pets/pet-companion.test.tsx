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
    // jsdom lays the panel out at 0x0, so the panel's bottom aligns with the launcher's bottom
    // (760) and the viewport clamp keeps it 8px inside the window's bottom edge.
    expect(companion).toHaveStyle({
      top: `${String(Math.min(760, window.innerHeight - 8))}px`,
      left: '24px',
    });
    expect(companion.style.bottom).toBe('');
    expect(screen.getByRole('button', { name: 'Close Cat' })).toHaveClass('hidden');
  });

  it('sends only explicitly entered text and scopes the conversation', async () => {
    const user = userEvent.setup();
    const view = render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    // The runtime hook now lives on `Companion` itself (L4: closed launcher), so it starts
    // model discovery and the watch loop as soon as the launcher mounts, before the panel is
    // ever opened - only a `send` is gated on the user actually composing one.
    expect(
      client.execute.mock.calls.some(
        ([endpoint]) => (endpoint as { body?: { operation?: string } }).body?.operation === 'send',
      ),
    ).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Talk with Cat' }));
    await screen.findByRole('dialog', { name: 'Conversation with Cat' });
    await user.type(screen.getByRole('textbox', { name: 'Message Cat' }), 'Help with a plan');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    });
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
      body: { sharedText: '', mode: 'chat' },
    });
    view.unmount();
  });

  it('switches to Design with its own messages and sends mode on every runtime call', async () => {
    // The connection now streams through the watch loop (`client.query`, `pets.watchRuntime`)
    // rather than the old read poll, so the mode-scoped fixture keys off the watch's own
    // `query.mode` instead of an `execute` command's body.
    client.query.mockImplementation((endpoint: { query?: { mode?: string } }) =>
      Promise.resolve({
        ...connected,
        messages:
          endpoint.query?.mode === 'consult'
            ? [
                {
                  id: 'design-reply',
                  role: 'assistant',
                  text: 'Design conversation',
                  actions: [],
                },
              ]
            : [{ id: 'chat-reply', role: 'assistant', text: 'Chat conversation', actions: [] }],
      }),
    );
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Talk with Cat' }));
    expect(await screen.findByText('Chat conversation')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Design' }));
    expect(await screen.findByText('Design conversation')).toBeVisible();
    expect(screen.queryByText('Chat conversation')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Chat' }));
    expect(await screen.findByText('Chat conversation')).toBeVisible();
    const scopedCalls = client.execute.mock.calls.filter(([endpoint]) =>
      ['read', 'models'].includes(
        (endpoint as { body?: { operation?: string } }).body?.operation ?? '',
      ),
    );
    expect(scopedCalls.length).toBeGreaterThan(0);
    expect(
      scopedCalls.every(([endpoint]) =>
        ['chat', 'consult'].includes((endpoint as { body: { mode: string } }).body.mode),
      ),
    ).toBe(true);
    expect(
      scopedCalls.some(
        ([endpoint]) => (endpoint as { body: { mode: string } }).body.mode === 'consult',
      ),
    ).toBe(true);
  });

  it('opens in Design from the template library entry point', async () => {
    render(
      <MemoryRouter initialEntries={['/w/33333333-3333-4333-8333-333333333333?pet=design']}>
        <PetCompanion />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('dialog', { name: 'Conversation with Cat' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Design' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByText(/Describe what you want to keep track of/)).toBeVisible();
  });

  async function openSettings(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'More conversation actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Chat settings' }));
  }

  it('remembers model choices separately for Chat and Design', async () => {
    client.execute.mockResolvedValue({
      ...connected,
      models: [
        { id: 'chat-model', name: 'Chat model', default: false },
        { id: 'design-model', name: 'Design model', default: false },
      ],
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Talk with Cat' }));
    await openSettings(user);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Model' }), 'chat-model');
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Design' }));
    await openSettings(user);
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Model' }), 'design-model');
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Chat' }));
    await openSettings(user);
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('chat-model');
    expect(
      localStorage.getItem(
        'nix.pet.model.33333333-3333-4333-8333-333333333333.44444444-4444-4444-8444-444444444444.consult',
      ),
    ).toBe('design-model');
  });

  it('prioritises replies and keeps secondary controls tucked into the overflow menu', async () => {
    // The connection - including its messages - now arrives through the watch loop
    // (`client.query`), not an `execute` read; the fixture is mocked there.
    client.query.mockResolvedValue({
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
    expect(screen.queryByRole('button', { name: 'New conversation' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'More conversation actions' }));
    expect(screen.getByRole('menuitem', { name: 'New conversation' })).toBeVisible();
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
    await openSettings(user);
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Model' }),
      'gpt-5.3-codex-spark',
    );
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.click(screen.getByRole('button', { name: 'Talk with Cat' }));
    await openSettings(user);
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('gpt-5.3-codex-spark');
  });

  it('shows response failures without requiring users to open the menu', async () => {
    client.query.mockResolvedValue({
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
    client.query.mockResolvedValue({
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
    // The connection arrives through the watch loop; kept in sync with `execute` (used by the
    // explicit "Reload conversation" action below) so a background watch tick never overwrites
    // what the reload just applied with this stale fixture.
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
    client.query.mockResolvedValue({
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
    expect(screen.queryByRole('button', { name: 'Approve request' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).not.toHaveTextContent('Waiting for your approval');

    const pendingConnection = {
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
    };
    client.execute.mockResolvedValue(pendingConnection);
    client.query.mockResolvedValue(pendingConnection);
    await user.click(screen.getByRole('button', { name: 'More conversation actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Reload conversation' }));
    expect(await screen.findByText('Waiting for your approval')).toBeVisible();
  });

  it('never shows "Waiting for your approval" nor badges the launcher for an auto-run read that is still pending', async () => {
    // Must-fix 1: an auto-run read (readWithoutAsking defaults on, and `search` is read-only)
    // stays `pending` until its own claim round trip finishes - here it never does, so the tool
    // is pending the whole test - but it must never read as something the owner is being asked
    // to decide, because it never was.
    const autoRunConnection = {
      ...connected,
      messages: [{ id: 'msg-1', role: 'user', text: 'Find my reading notes', actions: [] }],
      tools: [
        {
          id: 'auto-tool-1',
          arguments: JSON.stringify({
            operation: 'search',
            query: 'reading',
            itemId: '',
            parentId: '',
            title: '',
            markdown: '',
            propertiesJson: '',
          }),
          status: 'pending',
          result: '',
          claimId: '',
        },
      ],
    };
    client.query.mockResolvedValue(autoRunConnection);
    client.execute.mockImplementation((endpoint: unknown) => {
      const operation = (endpoint as { body?: { operation?: string } }).body?.operation;
      // The claim itself never succeeds in this test - which keeps the tool `pending` for the
      // whole run without ever reaching the (mocked-elsewhere) `@nix/companion` execution path.
      if (operation === 'tool_claim') return Promise.reject(new Error('offline'));
      return Promise.resolve(autoRunConnection);
    });
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    const launcher = await screen.findByRole('button', { name: 'Talk with Cat' });
    await waitFor(() => {
      expect(launcher).toHaveAttribute('aria-label', 'Talk with Cat');
    });
    expect(launcher.querySelector('[aria-hidden="true"].rounded-full')).toBeNull();

    await userEvent.click(launcher);
    const dialog = await screen.findByRole('dialog', { name: 'Conversation with Cat' });
    // Scoped to the header's own name/status pairing (not the read row's separate "Running…"
    // status, which shares the same role) - `getByText` finds the header `<h2>` and its status
    // sibling is the second child of their shared wrapper.
    const heading = within(dialog).getByRole('heading', { name: 'Cat' });
    const headerStatus = heading.parentElement?.querySelector('[role="status"]');
    expect(headerStatus).not.toHaveTextContent('Waiting for your approval');
  });

  it('shows no "(new reply)" badge for a conversation that is already finished the first time it loads', async () => {
    // Must-fix 2: the very first state this hook ever observes is a baseline, not a reply that
    // "just" finished - only a real thinking -> success transition earns the badge.
    client.query.mockResolvedValue({
      ...connected,
      state: 'success',
      messages: [
        { id: 'already-1', role: 'user', text: 'Earlier question', actions: [] },
        { id: 'already-1:assistant', role: 'assistant', text: 'Earlier answer', actions: [] },
      ],
    });
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    const launcher = await screen.findByRole('button', { name: 'Talk with Cat' });
    await waitFor(() => {
      expect(launcher).toHaveAttribute('aria-label', 'Talk with Cat');
    });
    expect(screen.queryByRole('button', { name: /new reply/ })).not.toBeInTheDocument();
  });

  it('focuses the sub-panel heading on open, and Escape backs out of it instead of closing', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Talk with Cat' }));
    await screen.findByRole('dialog', { name: 'Conversation with Cat' });
    await user.click(screen.getByRole('button', { name: 'More conversation actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Chat settings' }));
    const heading = await screen.findByRole('heading', { name: 'Chat settings', level: 3 });
    await waitFor(() => {
      expect(document.activeElement).toContainElement(heading);
    });

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Chat settings' })).not.toBeInTheDocument();
    });
    expect(screen.getByRole('dialog', { name: 'Conversation with Cat' })).toBeInTheDocument();
  });

  it('returns focus to the overflow menu trigger when Back leaves a sub-panel', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Talk with Cat' }));
    await screen.findByRole('dialog', { name: 'Conversation with Cat' });
    const trigger = screen.getByRole('button', { name: 'More conversation actions' });
    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: 'Past conversations' }));
    await screen.findByRole('heading', { name: 'Past conversations', level: 3 });
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => {
      expect(trigger).toHaveFocus();
    });
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

  it('draws no floating pet once the chat is given its own page everywhere', () => {
    localStorage.setItem('nix.pet.surface', 'page');
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    // jsdom applies no stylesheet, so `hidden` is asserted as the class the other launcher tests
    // assert; in a browser it takes both out of the layout and the accessibility tree.
    expect(screen.getByRole('complementary', { name: 'Cat companion' })).toHaveClass('hidden');
    expect(screen.getByRole('button', { name: 'Open Cat' })).toHaveClass('hidden');
  });
});
