import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BudgetLine, Finance, FinanceTransaction, QueryEndpoint } from '@nix/api-client';
import type * as UseFinanceModule from '../../../views/finance/use-finance';

const queries = vi.hoisted((): { transactions: unknown } => ({ transactions: null }));

vi.mock('../../../views/finance/use-finance', async () => {
  const actual = await vi.importActual<typeof UseFinanceModule>(
    '../../../views/finance/use-finance',
  );
  return {
    ...actual,
    useFinanceQuery: <T,>(endpoint: QueryEndpoint<T>) => {
      void endpoint;
      return { status: 'ready', data: queries.transactions, error: null };
    },
  };
});

import { FinanceTransactions, QuickAddDialog } from '../../../views/finance/finance-transactions';
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

describe('a stray tap outside the sheet', () => {
  it('keeps typed input instead of silently discarding it', () => {
    mount();
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Corner shop' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '12.40' } });

    const dialog = screen.getByRole('dialog', { name: 'Add a transaction' });
    // A backdrop click, as the browser sends it: pressed and released on the element itself.
    fireEvent.mouseDown(dialog);
    fireEvent.click(dialog);

    expect(screen.getByRole('dialog', { name: 'Add a transaction' })).toBeInTheDocument();
    expect(screen.getByText('Discard what you typed?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));

    expect(screen.getByLabelText('Description')).toHaveValue('Corner shop');
    expect(screen.getByLabelText('Amount')).toHaveValue('12.40');
  });

  it('discards through the prompt and closes only then', () => {
    const onClose = vi.fn();
    mount(onClose);
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Corner shop' } });

    const dialog = screen.getByRole('dialog', { name: 'Add a transaction' });
    fireEvent.mouseDown(dialog);
    fireEvent.click(dialog);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

const otherLine: BudgetLine = {
  ...line,
  id: 'c5555555-5555-4555-8555-555555555555',
  name: 'Transport',
};

const transactionA: FinanceTransaction = {
  id: 'c6666666-6666-4666-8666-666666666666',
  description: 'Corner shop',
  date: '2026-09-05',
  amount: -12.4,
  accountId,
  lineId: null,
  source: 'manual',
  postedFor: null,
  importKey: null,
  cleared: false,
};

const transactionB: FinanceTransaction = {
  ...transactionA,
  id: 'c7777777-7777-4777-8777-777777777777',
  description: 'Bus fare',
  amount: -3.2,
};

describe('bulk-assigning a selection of transactions to a budget line', () => {
  const setTransaction = vi.fn<FinanceViewState['setTransaction']>();
  const bulkState = {
    generation: 0,
    createTransaction: vi.fn(),
    setTransaction,
    deleteTransaction: vi.fn(),
  } as unknown as FinanceViewState;

  const mountList = () =>
    render(
      <FinanceTransactions
        state={bulkState}
        finance={{ ...finance, lines: [line, otherLine] }}
        month="2026-09"
      />,
    );

  beforeEach(() => {
    setTransaction.mockReset();
    queries.transactions = {
      transactions: [transactionA, transactionB],
      total: 2,
      truncated: false,
    };
  });

  it('assigns every selected transaction, one write per row', async () => {
    setTransaction.mockResolvedValue(null);
    mountList();

    fireEvent.click(screen.getByLabelText(`Select ${transactionA.description}`));
    fireEvent.click(screen.getByLabelText(`Select ${transactionB.description}`));
    fireEvent.change(screen.getByLabelText('Assign to line'), { target: { value: line.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => {
      expect(setTransaction).toHaveBeenCalledTimes(2);
    });
    expect(setTransaction).toHaveBeenCalledWith(
      transactionA.id,
      expect.objectContaining({ lineId: line.id }),
    );
    expect(setTransaction).toHaveBeenCalledWith(
      transactionB.id,
      expect.objectContaining({ lineId: line.id }),
    );
  });

  it('reports a partial failure honestly and keeps the failed row selected', async () => {
    setTransaction.mockImplementation((transactionId: string) =>
      Promise.resolve(
        transactionId === transactionB.id ? 'That budget line no longer exists.' : null,
      ),
    );
    mountList();

    fireEvent.click(screen.getByLabelText(`Select ${transactionA.description}`));
    fireEvent.click(screen.getByLabelText(`Select ${transactionB.description}`));
    fireEvent.change(screen.getByLabelText('Assign to line'), { target: { value: line.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => {
      expect(
        screen.getByText('Assigned 1 of 2; 1 was refused: That budget line no longer exists. (1)'),
      ).toBeInTheDocument();
    });
    expect(screen.getByLabelText(`Select ${transactionA.description}`)).not.toBeChecked();
    expect(screen.getByLabelText(`Select ${transactionB.description}`)).toBeChecked();
  });

  it('reports each distinct refusal reason with its own count, not just the last one', async () => {
    const transactionC: FinanceTransaction = {
      ...transactionA,
      id: 'c8888888-8888-4888-8888-888888888888',
      description: 'Coffee',
    };
    queries.transactions = {
      transactions: [transactionA, transactionB, transactionC],
      total: 3,
      truncated: false,
    };
    setTransaction.mockImplementation((transactionId: string) =>
      Promise.resolve(
        transactionId === transactionA.id
          ? null
          : transactionId === transactionB.id
            ? 'That budget line no longer exists.'
            : 'The account is closed.',
      ),
    );
    mountList();

    fireEvent.click(screen.getByLabelText(`Select ${transactionA.description}`));
    fireEvent.click(screen.getByLabelText(`Select ${transactionB.description}`));
    fireEvent.click(screen.getByLabelText(`Select ${transactionC.description}`));
    fireEvent.change(screen.getByLabelText('Assign to line'), { target: { value: line.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => {
      expect(
        screen.getByText(
          'Assigned 1 of 3; 2 were refused: That budget line no longer exists. (1), The account is closed. (1)',
        ),
      ).toBeInTheDocument();
    });
  });
});
