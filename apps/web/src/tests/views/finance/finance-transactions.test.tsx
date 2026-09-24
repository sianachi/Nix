import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BudgetLine, Finance } from '@nix/api-client';

import { QuickAddDialog } from '../../../views/finance/finance-transactions';
import type { FinanceState as FinanceViewState } from '../../../views/finance/use-finance';

const accountId = 'c3333333-3333-4333-8333-333333333333';
const line: BudgetLine = {
  id: 'c4444444-4444-4444-8444-444444444444',
  name: 'Groceries',
  section: 'Everyday spending',
  flow: 'expense',
  accountId,
  amount: 100,
  overrides: {},
  scheduled: false,
  dueDay: null,
  loanAccount: null,
  archived: false,
  position: 1,
};

const finance = {
  itemId: 'c1111111-1111-4111-8111-111111111111',
  settings: {
    currency: 'GBP',
    startMonth: '2026-09',
    endMonth: '2027-08',
    timezone: 'Europe/London',
  },
  accounts: [{ id: accountId, name: 'Everyday card', type: 'current' }],
  lines: [line],
  closedMonths: [],
} as unknown as Finance;

const createTransaction = vi.fn<FinanceViewState['createTransaction']>();

const state = {
  generation: 0,
  createTransaction,
  setTransaction: vi.fn(),
  deleteTransaction: vi.fn(),
} as unknown as FinanceViewState;

function mount(onClose: () => void = () => undefined) {
  return render(
    <QuickAddDialog state={state} finance={finance} month="2026-09" open onClose={onClose} />,
  );
}

beforeEach(() => {
  createTransaction.mockReset().mockResolvedValue(null);
});

describe('recording a transaction and adding another', () => {
  it('clears the amount and description but keeps date, account and line, and stays open', async () => {
    mount();
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '12.40' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Corner shop' } });
    fireEvent.change(screen.getByLabelText('Budget line'), { target: { value: line.id } });
    fireEvent.change(screen.getByLabelText('Account'), { target: { value: accountId } });
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-09-05' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save and add another' }));

    await waitFor(() => {
      expect(createTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'Corner shop',
          amount: -12.4,
          accountId,
          lineId: line.id,
        }),
      );
    });
    expect(screen.getByRole('dialog', { name: 'Add a transaction' })).toBeInTheDocument();
    expect(screen.getByLabelText('Amount')).toHaveValue('');
    expect(screen.getByLabelText('Description')).toHaveValue('');
    expect(screen.getByLabelText('Budget line')).toHaveValue(line.id);
    expect(screen.getByLabelText('Account')).toHaveValue(accountId);
    expect(screen.getByLabelText('Date')).toHaveValue('2026-09-05');
  });

  it('does not clear the form or close when the save is refused', async () => {
    createTransaction.mockResolvedValue('The account could not be reached.');
    mount();
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '12.40' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Corner shop' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save and add another' }));
    await waitFor(() => {
      expect(screen.getByText('The account could not be reached.')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Description')).toHaveValue('Corner shop');
  });

  it('closes on the ordinary Record button instead of staying open', async () => {
    const onClose = vi.fn();
    mount(onClose);
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '12.40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });
});
