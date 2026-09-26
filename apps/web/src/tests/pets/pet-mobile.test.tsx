import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { PetCompanion } from '../../pets/pet-companion';
import { stubViewport } from '../stub-viewport';

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

describe('companion on a phone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('innerWidth', 390);
    vi.stubGlobal('innerHeight', 844);
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

  it('shows the compact launcher on a phone and the regular one on a wide screen', async () => {
    stubViewport(390);
    const narrow = render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('img', { name: 'Cat' })).toHaveClass('size-14');
    narrow.unmount();

    stubViewport(true);
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('img', { name: 'Cat' })).toHaveClass('size-24');
  });

  it('opens a full-screen modal dialog on a phone and a floating non-modal card on a wide screen', async () => {
    stubViewport(390);
    const user = userEvent.setup();
    const narrow = render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Talk with Cat' }));
    expect(await screen.findByRole('dialog', { name: 'Conversation with Cat' })).toHaveAttribute(
      'aria-modal',
      'true',
    );
    narrow.unmount();

    stubViewport(true);
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Talk with Cat' }));
    expect(await screen.findByRole('dialog', { name: 'Conversation with Cat' })).toHaveAttribute(
      'aria-modal',
      'false',
    );
  });

  it('returns focus to the launcher when the phone dialog closes, by Close or Escape', async () => {
    stubViewport(390);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    const launcher = await screen.findByRole('button', { name: 'Talk with Cat' });
    await user.click(launcher);
    await screen.findByRole('dialog', { name: 'Conversation with Cat' });
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(launcher).toHaveFocus();
    });

    await user.click(launcher);
    const dialog = await screen.findByRole('dialog', { name: 'Conversation with Cat' });
    dialog.focus();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(launcher).toHaveFocus();
    });
  });

  it('closes the phone dialog on the browser back gesture', async () => {
    stubViewport(390);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Talk with Cat' }));
    await screen.findByRole('dialog', { name: 'Conversation with Cat' });

    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('clamps a stored off-screen position into view on a phone', async () => {
    stubViewport(390);
    localStorage.setItem('nix.pet.position', JSON.stringify({ x: 5000, y: 5000 }));
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    const launcher = await screen.findByRole('button', { name: 'Talk with Cat' });
    // jsdom never lays out a real box, so a zero-size rect (as the launcher would also report
    // while genuinely hidden) is skipped by design; giving it a realistic size here is what
    // lets the clamp run and be asserted, the same way it would once a phone renders it.
    vi.spyOn(launcher, 'getBoundingClientRect').mockReturnValue({
      width: 64,
      height: 64,
      top: 0,
      left: 0,
      right: 64,
      bottom: 64,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    const companion = screen.getByRole('complementary', { name: 'Cat companion' });
    await waitFor(() => {
      expect(companion).toHaveStyle({ left: '318px', top: '772px' });
    });
  });

  it('does not clamp a position while the launcher measures zero (hidden by the keyboard)', async () => {
    stubViewport(390);
    localStorage.setItem('nix.pet.position', JSON.stringify({ x: 5000, y: 5000 }));
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await screen.findByRole('button', { name: 'Talk with Cat' });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    const companion = screen.getByRole('complementary', { name: 'Cat companion' });
    expect(companion).toHaveStyle({ left: '5000px', top: '5000px' });
  });

  it('hides the launcher while the software keyboard occludes the page', async () => {
    stubViewport(390);
    const viewport = Object.assign(new EventTarget(), { height: 800, scale: 1 });
    vi.stubGlobal('innerHeight', 800);
    vi.stubGlobal('visualViewport', viewport);
    render(
      <MemoryRouter>
        <PetCompanion />
        <input aria-label="Unrelated field" />
      </MemoryRouter>,
    );
    const launcher = await screen.findByRole('button', { name: 'Talk with Cat' });
    expect(launcher).not.toHaveClass('hidden');

    act(() => {
      screen.getByRole('textbox', { name: 'Unrelated field' }).focus();
      viewport.height = 480;
      viewport.dispatchEvent(new Event('resize'));
    });
    await waitFor(() => {
      expect(launcher).toHaveClass('hidden');
    });
  });

  it('never opens the conversation from a drag', async () => {
    stubViewport(390);
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    const launcher = await screen.findByRole('button', { name: 'Talk with Cat' });
    fireEvent.pointerDown(launcher, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(launcher, {
      pointerId: 1,
      movementX: 10,
      movementY: 10,
      clientX: 20,
      clientY: 20,
    });
    fireEvent.pointerUp(launcher, { pointerId: 1 });
    fireEvent.click(launcher);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens on a genuine tap even right after a drag whose click never fired', async () => {
    stubViewport(390);
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    const launcher = await screen.findByRole('button', { name: 'Talk with Cat' });
    // A touch drag past the slop dispatches no `click` at all; simulate that abandoned
    // sequence (no trailing click), then a plain, separate tap.
    fireEvent.pointerDown(launcher, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(launcher, { pointerId: 1, clientX: 40, clientY: 40 });
    fireEvent.pointerUp(launcher, { pointerId: 1 });

    fireEvent.pointerDown(launcher, { pointerId: 2, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(launcher, { pointerId: 2 });
    fireEvent.click(launcher);
    expect(await screen.findByRole('dialog', { name: 'Conversation with Cat' })).toBeVisible();
  });

  it('locks and restores background scroll around the phone dialog', async () => {
    stubViewport(390);
    document.body.style.overflow = 'auto';
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Talk with Cat' }));
    await screen.findByRole('dialog', { name: 'Conversation with Cat' });
    expect(document.body.style.overflow).toBe('hidden');

    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(document.body.style.overflow).toBe('auto');
    });
  });
});
