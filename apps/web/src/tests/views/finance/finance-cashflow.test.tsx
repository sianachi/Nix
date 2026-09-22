import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CashFlow, Finance } from '@nix/api-client';
import { FinanceCashFlow } from '../../../views/finance/finance-cashflow';
import { formatMonth } from '../../../views/finance/money';
import type { FinanceState } from '../../../views/finance/use-finance';

const query = vi.hoisted((): { data: unknown } => ({ data: null }));
vi.mock('../../../views/finance/use-finance', () => ({
  useFinanceQuery: () => ({ status: 'ready', data: query.data, error: null }),
}));

const rootId = 'c1111111-1111-4111-8111-111111111111';
const finance = {
  itemId: rootId,
  settings: { currency: 'GBP', emergencyFundMonths: 3 },
} as Finance;
const state = { generation: 0 } as FinanceState;
const march = {
  month: '2027-03',
  source: 'plan' as const,
  income: 4000,
  paidThisMonth: 1500,
  cardSpend: 400,
  cardPaymentOut: 400,
  cashNet: 2100,
  closingBank: 8000,
  cardOwed: 400,
  netPosition: 7600,
  emergencyTarget: 5700,
  bufferMet: true,
};
const projection: CashFlow = {
  itemId: rootId,
  openingBank: 2000,
  openingCardOwed: 100,
  openingNetPosition: 1900,
  emergencyTarget: 5700,
  emergencyBasisMonth: '2027-03',
  bufferMetIn: '2027-03',
  months: [march, { ...march, month: '2027-04', emergencyTarget: 5550 }],
};

describe('cash-flow emergency targets', () => {
  it('shows each month target and follows the selected month in the summary', () => {
    query.data = projection;
    const view = render(<FinanceCashFlow state={state} finance={finance} month="2027-04" />);
    const april = screen.getByRole('row', { name: new RegExp(formatMonth('2027-04')) });
    expect(within(april).getByText('£5,550.00')).toBeInTheDocument();
    expect(screen.getByText('£5,550')).toBeInTheDocument();
    expect(
      screen.getByText(`3 months of ${formatMonth('2027-04')}'s planned outgoings`),
    ).toBeInTheDocument();

    view.rerender(<FinanceCashFlow state={state} finance={finance} month="2027-03" />);
    expect(screen.getByText('£5,700')).toBeInTheDocument();
    expect(screen.queryByText('£5,550')).not.toBeInTheDocument();
  });
});
