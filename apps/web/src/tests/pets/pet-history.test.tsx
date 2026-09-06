import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { petConnectionSchema } from '@nix/api-client';
import { PetHistory } from '../../pets/pet-history';

it('requires a second explicit confirmation before deleting an archived conversation', async () => {
  const id = '33333333-3333-4333-8333-333333333333';
  const response = petConnectionSchema.parse({
    provider: 'chatgpt',
    status: 'connected',
    reason: '',
    canConnect: false,
    history: [{ id, title: 'Plan', createdAt: '2026-09-06T12:00:00Z' }],
    messages: [{ id: 'one', role: 'user', text: 'Keep this plan', actions: [] }],
  });
  const execute = vi.fn().mockResolvedValue(response);
  render(
    <PetHistory
      client={{ execute }}
      workspaceId="11111111-1111-4111-8111-111111111111"
      petId="22222222-2222-4222-8222-222222222222"
      name="Pip"
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Conversation history' }));
  await user.selectOptions(await screen.findByRole('combobox', { name: 'Saved conversation' }), id);
  await screen.findByText('You: Keep this plan');
  await user.click(screen.getByRole('button', { name: 'Remove saved conversation' }));
  expect(execute).toHaveBeenCalledTimes(2);
  await user.click(screen.getByRole('button', { name: 'Keep conversation' }));
  expect(execute).toHaveBeenCalledTimes(2);
  await user.click(screen.getByRole('button', { name: 'Remove saved conversation' }));
  await user.click(screen.getByRole('button', { name: 'Delete saved conversation permanently' }));
  await waitFor(() => {
    expect(execute).toHaveBeenCalledTimes(3);
  });
  expect(execute.mock.calls[2]?.[0]).toMatchObject({
    body: { operation: 'delete_history', historyId: id },
  });
});
