import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BudgetGrid, BudgetLine, Finance } from '@nix/api-client';

import { FinanceBudget } from '../../../views/finance/finance-budget';
import type { FinanceState as FinanceViewState } from '../../../views/finance/use-finance';

const budgetQuery = vi.hoisted((): { data: unknown } => ({ data: null }));

vi.mock('../../../views/finance/use-finance', () => ({
  useFinanceQuery: () => ({ status: 'ready', data: budgetQuery.data, error: null }),
}));

const line: BudgetLine = {
  id: 'c4444444-4444-4444-8444-444444444444',
  name: 'Groceries',
  section: 'Everyday spending',
  flow: 'expense',
  accountId: 'c3333333-3333-4333-8333-333333333333',
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
  },
  accounts: [{ id: line.accountId, name: 'Everyday card' }],
} as Finance;

function budgetGrid(): BudgetGrid {
  const cell = { month: '2026-09', plan: 100, actual: 25, variance: -75, transactions: 1 };
  return {
    itemId: finance.itemId,
    months: ['2026-09'],
    sections: [
      {
        name: line.section,
        flow: 'expense',
        lines: [{ line, cells: [cell] }],
        totals: [cell],
      },
    ],
    totals: [
      {
        month: '2026-09',
        closed: false,
        plan: { income: 0, paidThisMonth: 100, cardSpend: 0, outgoings: 100, net: -100 },
        actual: { income: 0, paidThisMonth: 25, cardSpend: 0, outgoings: 25, net: -25 },
        unassignedOutflow: 0,
        unassignedInflow: 0,
        unassignedTransactions: 0,
        cumulativeNetPlan: -100,
        cumulativeNetActual: -25,
      },
    ],
  };
}

function mount(): void {
  render(
    <FinanceBudget
      state={{ generation: 0 } as FinanceViewState}
      finance={finance}
      month="2026-09"
      onMonth={() => undefined}
    />,
  );
}

describe('monthly budget remaining', () => {
  beforeEach(() => {
    budgetQuery.data = budgetGrid();
  });

  it('shows plan minus actual in the month and its totals regardless of the year figure', () => {
    mount();

    const groceries = screen.getByRole('row', { name: /Groceries/ });
    expect(within(groceries).getAllByRole('cell').at(-1)).toHaveTextContent('£75.00');
    const section = screen.getByRole('row', { name: /EVERYDAY SPENDING/ });
    expect(within(section).getAllByRole('cell').at(-1)).toHaveTextContent('£75.00');
    const outgoings = screen.getByRole('row', { name: /Total outgoings/ });
    expect(within(outgoings).getAllByRole('cell').at(-1)).toHaveTextContent('£75.00');

    fireEvent.click(screen.getByRole('button', { name: 'Year' }));
    fireEvent.click(screen.getByRole('button', { name: 'Left' }));
    fireEvent.click(screen.getByRole('button', { name: 'Month' }));

    const monthLeft = within(screen.getByRole('row', { name: /Groceries/ }))
      .getAllByRole('cell')
      .at(-1);
    expect(monthLeft).toHaveTextContent('£75.00');
    expect(monthLeft).not.toHaveTextContent('£25.00');
  });
});
