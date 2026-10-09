import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { PetCompanion } from '../../pets/pet-companion';
import { usePetAttention } from '../../pets/pet-attention';

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

const base = {
  provider: 'chatgpt',
  status: 'connected',
  reason: 'Connected',
  canConnect: false,
  verificationUrl: '',
  userCode: '',
};

async function openCompanion() {
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <PetCompanion />
    </MemoryRouter>,
  );
  await user.click(await screen.findByRole('button', { name: 'Talk with Cat' }));
  await screen.findByRole('dialog', { name: 'Conversation with Cat' });
  return user;
}

describe('companion live wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it('renders tool rows after the latest turn and before its final answer, and gives earlier turns none', async () => {
    client.query.mockResolvedValue({
      ...base,
      state: 'thinking',
      messages: [
        { id: 'turn-1', role: 'user', text: 'First request' },
        { id: 'turn-1:assistant', role: 'assistant', text: 'First reply' },
        { id: 'turn-2', role: 'user', text: 'Second request' },
        {
          id: 'turn-2:commentary:aaaa',
          role: 'assistant',
          text: 'Looking into it.',
        },
      ],
      tools: [
        {
          id: 'tool-1',
          arguments: JSON.stringify({
            operation: 'create_note',
            title: 'Plan',
            markdown: 'Short note.',
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
    client.execute.mockResolvedValue(base);
    await openCompanion();

    const log = await screen.findByRole('log', { name: 'Conversation messages' });
    const text = log.textContent;
    const order = [
      'First request',
      'First reply',
      'Second request',
      'Looking into it.',
      'Approve this change?',
    ].map((fragment) => text.indexOf(fragment));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));

    // The earlier, finished turn shows no approval controls of its own.
    expect(screen.getByRole('button', { name: 'Approve request' })).toBeVisible();
  });

  it('shows a still-streaming draft with a caret, "Writing" status, and no thinking dots, excluded from the live region', async () => {
    client.query.mockResolvedValue({
      ...base,
      state: 'thinking',
      messages: [
        { id: 'turn-3', role: 'user', text: 'Draft this for me' },
        {
          id: 'turn-3:draft:bbbb',
          role: 'assistant',
          text: 'Here is the start of a reply',
        },
      ],
      tools: [],
    });
    client.execute.mockResolvedValue(base);
    await openCompanion();

    const draftText = await screen.findByText('Here is the start of a reply');
    const draftContainer = draftText.closest('[aria-live]');
    expect(draftContainer).toHaveAttribute('aria-live', 'off');
    expect(draftContainer?.querySelector('[aria-hidden="true"]')).toBeTruthy();
    expect(screen.getByRole('status')).toHaveTextContent('Writing');
    expect(screen.queryByText(/is thinking/)).not.toBeInTheDocument();
  });

  it('badges the closed launcher for a pending tool and names it "(needs approval)"', async () => {
    client.query.mockResolvedValue({
      ...base,
      state: 'success',
      messages: [{ id: 'turn-4', role: 'user', text: 'Create a note' }],
      tools: [
        {
          id: 'tool-4',
          arguments: JSON.stringify({
            operation: 'create_note',
            title: 'Plan',
            markdown: 'Short note.',
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
    client.execute.mockResolvedValue(base);
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );

    const launcher = await screen.findByRole('button', { name: /needs approval/ });
    expect(launcher).toHaveAttribute('aria-label', 'Talk with Cat (needs approval)');
    expect(launcher.querySelector('[aria-hidden="true"].rounded-full')).toBeTruthy();
  });

  it('tells the navigation about a pending tool when the page-everywhere choice leaves no launcher', async () => {
    // This file's environment has no working storage; the one preference this test needs is
    // answered directly.
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => (key === 'nix.pet.surface' ? 'page' : null),
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
    });
    client.query.mockResolvedValue({
      ...base,
      state: 'success',
      messages: [{ id: 'turn-4', role: 'user', text: 'Create a note' }],
      tools: [
        {
          id: 'tool-4',
          arguments: JSON.stringify({
            operation: 'create_note',
            title: 'Plan',
            markdown: 'Short note.',
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
    client.execute.mockResolvedValue(base);
    function Attention() {
      return <output>{usePetAttention() ?? 'none'}</output>;
    }
    const view = render(
      <MemoryRouter>
        <PetCompanion />
        <Attention />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('approval');
    });
    // Gone with the companion, so the page (which shows the request itself) starts clean.
    view.rerender(
      <MemoryRouter>
        <Attention />
      </MemoryRouter>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('none');
    vi.unstubAllGlobals();
  });

  it('badges the closed launcher for a reply that finished while closed, then clears it on open', async () => {
    client.query
      .mockResolvedValueOnce({
        ...base,
        state: 'thinking',
        messages: [{ id: 'turn-5', role: 'user', text: 'Plan my week' }],
        tools: [],
      })
      .mockResolvedValue({
        ...base,
        state: 'success',
        messages: [
          { id: 'turn-5', role: 'user', text: 'Plan my week' },
          { id: 'turn-5:assistant', role: 'assistant', text: 'Here is your week.' },
        ],
        tools: [],
      });
    client.execute.mockResolvedValue(base);
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );

    const launcher = await screen.findByRole('button', { name: /new reply/ });
    expect(launcher).toHaveAttribute('aria-label', 'Talk with Cat (new reply)');

    const user = userEvent.setup();
    await user.click(launcher);
    expect(await screen.findByRole('button', { name: 'Close Cat' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /new reply/ })).not.toBeInTheDocument();
  });
});
