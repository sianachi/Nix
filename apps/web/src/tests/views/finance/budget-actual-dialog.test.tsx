import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BudgetCell, BudgetLine, Finance, QueryEndpoint } from '@nix/api-client';
import type * as UseFinanceModule from '../../../views/finance/use-finance';

vi.mock('../../../views/finance/use-finance', async () => {
  const actual = await vi.importActual<typeof UseFinanceModule>(
    '../../../views/finance/use-finance',
  );
  return {
    ...actual,
    useFinanceQuery: <T,>(endpoint: QueryEndpoint<T>) => {
      void endpoint;
      return {
        status: 'ready',
        data: { transactions: [], total: 0, truncated: false },
        error: null,
      };
    },
  };
});

import { BudgetActualDialog } from '../../../views/finance/budget-actual-dialog';
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

const cell: BudgetCell = {
  month: '2026-09',
  plan: 100,
  actual: 25,
  variance: -75,
  transactions: 1,
};

const setActual = vi.fn<FinanceViewState['setActual']>();
const state = {
  generation: 0,
  setActual,
  deleteTransaction: vi.fn(),
  createTransaction: vi.fn(),
  setTransaction: vi.fn(),
} as unknown as FinanceViewState;

function mount(onClose: () => void = () => undefined) {
  return render(
    <BudgetActualDialog
      state={state}
      finance={finance}
      line={line}
      month="2026-09"
      cell={cell}
      onClose={onClose}
    />,
  );
}

describe('a stray tap outside the sheet, while a new total is mid-edit', () => {
  it('keeps the retyped total instead of silently discarding it', () => {
    mount();
    fireEvent.change(screen.getByRole('textbox', { name: "Bring this month's total to" }), {
      target: { value: '40' },
    });

    const dialog = screen.getByRole('dialog');
    fireEvent.mouseDown(dialog);
    fireEvent.click(dialog);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Discard what you typed?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));

    expect(screen.getByRole('textbox', { name: "Bring this month's total to" })).toHaveValue('40');
  });

  it('discards through the prompt and closes only then', () => {
    const onClose = vi.fn();
    mount(onClose);
    fireEvent.change(screen.getByRole('textbox', { name: "Bring this month's total to" }), {
      target: { value: '40' },
    });

    const dialog = screen.getByRole('dialog');
    fireEvent.mouseDown(dialog);
    fireEvent.click(dialog);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not prompt when the total was never touched', () => {
    const onClose = vi.fn();
    mount(onClose);

    const dialog = screen.getByRole('dialog');
    fireEvent.mouseDown(dialog);
    fireEvent.click(dialog);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Discard what you typed?')).not.toBeInTheDocument();
  });
});
