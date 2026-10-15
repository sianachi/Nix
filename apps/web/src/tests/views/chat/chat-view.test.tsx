import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Editor, LongReply, Reader } from '../../../views/chat/chat-view.stories';

describe('saved conversation notes', () => {
  it('shows persisted messages and a composer when Core permits sending', async () => {
    render(Editor.render());
    expect(await screen.findByText(/Research and planning share a priority/)).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Change sources' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save insight as note' })).toBeVisible();
  });
  it('keeps the transcript readable without exposing editor controls to a reader', async () => {
    render(Reader.render());
    expect(await screen.findByText(/Research and planning share a priority/)).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change sources' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
  });
  it('previews the complete long reply when saving an insight', async () => {
    render(LongReply.render());
    const save = await screen.findByRole('button', { name: 'Save insight as note' });
    fireEvent.click(save);
    expect(await screen.findByRole('textbox', { name: 'Insight content' })).toHaveValue(
      'a'.repeat(6000) + ' Final conclusion.',
    );
  });
});
