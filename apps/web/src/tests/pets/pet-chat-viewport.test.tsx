import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PetChatViewport } from '../../pets/pet-chat-viewport';

describe('pet conversation viewport', () => {
  it('keeps a keyboard-accessible message region separate from the composer', () => {
    render(
      <PetChatViewport latestKey="one">
        <p data-pet-latest-message="">A readable reply</p>
      </PetChatViewport>,
    );
    expect(screen.getByRole('log', { name: 'Conversation messages' })).toHaveAttribute(
      'tabindex',
      '0',
    );
    expect(screen.getByText('A readable reply')).toBeVisible();
  });

  it('does not pull readers away from older messages when a reply arrives', async () => {
    const user = userEvent.setup();
    const view = render(
      <PetChatViewport latestKey="one">
        <p>Earlier reply</p>
      </PetChatViewport>,
    );
    const log = screen.getByRole('log');
    Object.defineProperties(log, { scrollHeight: { value: 1200 }, clientHeight: { value: 300 } });
    log.scrollTop = 100;
    fireEvent.scroll(log);
    view.rerender(
      <PetChatViewport latestKey="two">
        <p>Earlier reply</p>
        <p data-pet-latest-message="">New reply</p>
      </PetChatViewport>,
    );
    expect(log.scrollTop).toBe(100);
    await user.click(screen.getByRole('button', { name: 'Show latest reply' }));
    expect(screen.queryByRole('button', { name: 'Show latest reply' })).not.toBeInTheDocument();
  });

  it('brings the beginning of a new response into view when following the chat', () => {
    const view = render(
      <PetChatViewport latestKey="one">
        <p>Earlier reply</p>
      </PetChatViewport>,
    );
    const log = screen.getByRole('log');
    log.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    view.rerender(
      <PetChatViewport latestKey="one">
        <p data-pet-latest-message="">A long reply</p>
      </PetChatViewport>,
    );
    screen.getByText('A long reply').getBoundingClientRect = () => ({ top: 700 }) as DOMRect;
    view.rerender(
      <PetChatViewport latestKey="two">
        <p data-pet-latest-message="">A long reply</p>
      </PetChatViewport>,
    );
    expect(log.scrollTop).toBe(600);
  });
});
