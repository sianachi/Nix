import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BudgetGrid, BudgetLine, Finance, QueryEndpoint } from '@nix/api-client';

import { FinanceBudget } from '../../../views/finance/finance-budget';
import type { FinanceState as FinanceViewState } from '../../../views/finance/use-finance';

const queries = vi.hoisted(
  (): {
    grid: unknown;
    transactions: unknown;
    seen: { operation: string; query?: Readonly<Record<string, unknown>> }[];
  } => ({ grid: null, transactions: null, seen: [] }),
);

vi.mock('../../../views/finance/use-finance', () => ({
  useFinanceQuery: <T,>(endpoint: QueryEndpoint<T>) => {
    queries.seen.push({
      operation: endpoint.operation,
      ...(endpoint.query === undefined ? {} : { query: endpoint.query }),
    });
    if (endpoint.operation === 'finance.transactions') {
      return { status: 'ready', data: queries.transactions, error: null };
    }
    return { status: 'ready', data: queries.grid, error: null };
  },
}));

const accountId = 'c3333333-3333-4333-8333-333333333333';
const otherAccountId = 'c2222222-2222-4222-8222-222222222222';
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
  accounts: [
    { id: accountId, name: 'Everyday card', type: 'credit_card' },
    { id: otherAccountId, name: 'Current account', type: 'current' },
  ],
  lines: [line],
  closedMonths: [],
} as unknown as Finance;

const cell = { month: '2026-09', plan: 100, actual: 25, variance: -75, transactions: 1 };

function budgetGrid(): BudgetGrid {
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
    accountId: null,
  };
}

const transaction = {
  id: 'c5555555-5555-4555-8555-555555555555',
  description: 'Example shop',
  date: '2026-09-03',
  amount: -25,
  accountId,
  lineId: line.id,
  source: 'manual' as const,
  postedFor: null,
  importKey: null,
  cleared: false,
};

const setLine = vi.fn<FinanceViewState['setLine']>();
const setActual = vi.fn<FinanceViewState['setActual']>();
const deleteTransaction = vi.fn<FinanceViewState['deleteTransaction']>();
const createTransaction = vi.fn<FinanceViewState['createTransaction']>();

const state = {
  generation: 0,
  setLine,
  setActual,
  deleteTransaction,
  createTransaction,
  setTransaction: vi.fn(),
} as unknown as FinanceViewState;

function budget(current: Finance) {
  return (
    <FinanceBudget state={state} finance={current} month="2026-09" onMonth={() => undefined} />
  );
}

function mount() {
  return render(budget(finance));
}

beforeEach(() => {
  queries.grid = budgetGrid();
  queries.transactions = { transactions: [transaction], total: 1, truncated: false };
  queries.seen = [];
  setLine.mockReset().mockResolvedValue(null);
  setActual.mockReset().mockResolvedValue({
    lineId: line.id,
    month: '2026-09',
    before: 25,
    after: 80,
    transaction: null,
  });
  deleteTransaction.mockReset().mockResolvedValue(null);
  createTransaction.mockReset().mockResolvedValue(null);
});

describe('monthly budget remaining', () => {
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

describe('narrowing the budget to an account', () => {
  it('asks Core for that account alone and names the totals only once Core answers', () => {
    const view = mount();
    expect(queries.seen.at(-1)?.query).not.toHaveProperty('accountId');

    fireEvent.change(screen.getByRole('combobox', { name: 'Account' }), {
      target: { value: accountId },
    });

    expect(queries.seen.at(-1)?.query).toMatchObject({ accountId });
    // The grid on screen is still every account's, so the labels do not claim otherwise yet.
    expect(screen.queryByRole('row', { name: /Net on Everyday card/ })).not.toBeInTheDocument();

    queries.grid = { ...budgetGrid(), accountId };
    view.rerender(budget(finance));
    expect(screen.getByRole('row', { name: /Net on Everyday card/ })).toBeInTheDocument();
    expect(screen.getByText(/September 2026 on Everyday card/)).toBeInTheDocument();
  });
});

describe('editing a plan in place', () => {
  it('saves a month override on Enter and keeps every other month as it was', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /^Plan for Groceries in September 2026/ }));
    const field = screen.getByRole('textbox', { name: 'Plan for Groceries in September 2026' });
    fireEvent.change(field, { target: { value: '120' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => {
      expect(setLine).toHaveBeenCalledWith(
        line.id,
        expect.objectContaining({ amount: 100, overrides: { '2026-09': 120 } }),
      );
    });
  });

  it('clears the override when the usual amount is typed back, and Escape abandons the edit', async () => {
    const grid = budgetGrid();
    queries.grid = {
      ...grid,
      sections: grid.sections.map((section) => ({
        ...section,
        lines: [
          {
            line: { ...line, overrides: { '2026-09': 120 } },
            cells: [{ ...cell, plan: 120, variance: -95 }],
          },
        ],
      })),
    };
    mount();
    fireEvent.click(screen.getByRole('button', { name: /^Plan for Groceries in September 2026/ }));
    const field = screen.getByRole('textbox', { name: 'Plan for Groceries in September 2026' });
    fireEvent.change(field, { target: { value: '100' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => {
      expect(setLine).toHaveBeenCalledWith(line.id, expect.objectContaining({ overrides: {} }));
    });

    fireEvent.click(screen.getByRole('button', { name: /^Plan for Groceries in September 2026/ }));
    const again = screen.getByRole('textbox', { name: 'Plan for Groceries in September 2026' });
    fireEvent.change(again, { target: { value: '999' } });
    fireEvent.keyDown(again, { key: 'Escape' });
    expect(setLine).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole('button', { name: /^Plan for Groceries in September 2026/ }),
    ).toBeInTheDocument();
  });

  it('refuses a typed value that is not an amount without sending it', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /^Plan for Groceries in September 2026/ }));
    const field = screen.getByRole('textbox', { name: 'Plan for Groceries in September 2026' });
    fireEvent.change(field, { target: { value: 'lots' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription(/Type an amount of zero or more/);
    expect(setLine).not.toHaveBeenCalled();
  });
});

describe('what is behind an actual', () => {
  it('opens the transactions behind the figure and records a new total for the month', async () => {
    mount();
    fireEvent.click(
      screen.getByRole('button', { name: /^Actual for Groceries in September 2026/ }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Groceries in September 2026' });
    expect(within(dialog).getByText('Example shop')).toBeInTheDocument();
    expect(queries.seen.at(-1)).toMatchObject({
      operation: 'finance.transactions',
      query: { month: '2026-09', lineId: line.id },
    });

    const total = within(dialog).getByLabelText("Bring this month's total to");
    expect(total).toHaveValue('25');
    fireEvent.change(total, { target: { value: '80' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Record' }));

    await waitFor(() => {
      expect(setActual).toHaveBeenCalledWith(line.id, '2026-09', { amount: 80 });
    });
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: 'Groceries in September 2026' }),
      ).not.toBeInTheDocument();
    });
  });

  it('deletes one transaction after a second click, and opens the add form on the line', async () => {
    const view = mount();
    fireEvent.click(
      screen.getByRole('button', { name: /^Actual for Groceries in September 2026/ }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Groceries in September 2026' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete Example shop' }));
    expect(deleteTransaction).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, delete Example shop' }));
    await waitFor(() => {
      expect(deleteTransaction).toHaveBeenCalledWith(transaction.id);
    });
    // The figures at the top follow the grid, so the next refetch is what the dialog shows.
    const grid = budgetGrid();
    const emptied = { ...cell, actual: 0, variance: -100, transactions: 0 };
    queries.grid = {
      ...grid,
      sections: grid.sections.map((section) => ({
        ...section,
        lines: [{ line, cells: [emptied] }],
      })),
    };
    view.rerender(budget(finance));
    expect(within(dialog).getByText('Actual').nextSibling).toHaveTextContent('£0.00');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Add transaction' }));
    const add = screen.getByRole('dialog', { name: 'Add a transaction' });
    expect(within(add).getByLabelText('Budget line')).toHaveValue(line.id);
    expect(within(add).getByLabelText('Account')).toHaveValue(accountId);
    fireEvent.change(within(add).getByLabelText('Amount'), { target: { value: '12' } });
    fireEvent.change(within(add).getByLabelText('Description'), {
      target: { value: 'Example bakery' },
    });
    fireEvent.click(within(add).getByRole('button', { name: 'Record' }));
    await waitFor(() => {
      expect(createTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ amount: -12, lineId: line.id, accountId }),
      );
    });
    await waitFor(() => {
      expect(
        screen.getByRole('dialog', { name: 'Groceries in September 2026' }),
      ).toBeInTheDocument();
    });
  });

  it('keeps a closed month read-only', () => {
    render(budget({ ...finance, closedMonths: ['2026-09'] }));
    expect(
      screen.queryByRole('button', { name: /^Plan for Groceries in September 2026/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: /^Actual for Groceries in September 2026/ }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Groceries in September 2026' });
    expect(within(dialog).queryByLabelText("Bring this month's total to")).not.toBeInTheDocument();
    expect(within(dialog).getByText(/September 2026 is closed/)).toBeInTheDocument();
  });
});
