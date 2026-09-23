import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import {
  budgetActualSchema,
  budgetGridSchema,
  cashFlowSchema,
  financeAccountSchema,
  financeAccountsSchema,
  financeDashboardSchema,
  financeImportSchema,
  financeMonthSchema,
  financeSchema,
  financeTransactionSchema,
  financeTransactionsSchema,
  budgetLineSchema,
  loanScheduleSchema,
  monthChecklistSchema,
  postScheduledSchema,
  type BudgetActual,
  type BudgetGrid,
  type BudgetLine,
  type CashFlow,
  type Finance,
  type FinanceAccount,
  type FinanceAccountType,
  type FinanceAccounts,
  type FinanceDashboard,
  type FinanceImport,
  type FinanceMonth,
  type FinanceTransaction,
  type FinanceTransactions,
  type BudgetFlow,
  type LoanSchedule,
  type MonthChecklist,
  type PostScheduled,
} from '../schemas/finance.js';
import { noContentSchema } from '../schemas/index.js';

// Everything under one finance root. Amounts are decimals with at most two places; Core does the
// arithmetic and refuses anything else. Reads are cached under the root's item key and every
// write invalidates that key, because a single transaction changes the grid, the cash flow and
// the dashboard at once.

export interface FinanceSettingsInput {
  readonly currency: string;
  readonly startMonth: string;
  readonly horizonMonths: number;
  readonly openingCash: number;
  readonly emergencyFundMonths: number;
  readonly timezone: string;
}

export interface FinanceAccountInput {
  readonly name: string;
  readonly type: FinanceAccountType;
  readonly limit: number | null;
  readonly openingBalance: number;
  readonly settlesFrom: string | null;
  readonly apr: number | null;
  readonly payment: number | null;
  readonly overpayment: number | null;
  readonly target: number | null;
  readonly archived?: boolean;
}

export interface BudgetLineInput {
  readonly name: string;
  readonly section: string;
  readonly flow: BudgetFlow;
  readonly accountId: string;
  readonly amount: number;
  readonly overrides: Readonly<Record<string, number>> | null;
  readonly scheduled: boolean;
  readonly dueDay: number | null;
  readonly loanAccount: string | null;
  readonly archived?: boolean;
}

/** Amount is the cash effect: negative when money left the account. */
export interface FinanceTransactionInput {
  readonly description: string;
  readonly date: string;
  readonly amount: number;
  readonly accountId: string;
  readonly lineId: string | null;
  readonly cleared?: boolean;
}

/**
 * What a line's actual for a month should come to. Core records the one transaction that gets it
 * there, so the figure is never typed over.
 */
export interface BudgetActualInput {
  readonly amount: number;
  readonly description?: string | null;
  readonly date?: string | null;
}

export interface FinanceTransactionsQuery {
  readonly month?: string;
  readonly accountId?: string;
  readonly lineId?: string;
  readonly unassigned?: boolean;
  readonly limit?: number;
}

export interface FinanceImportInput {
  readonly accountId: string;
  readonly csv: string;
  readonly commit: boolean;
}

const root = (itemId: string) => `/api/v1/items/${encodeURIComponent(itemId)}/finance`;
const itemKey = (itemId: string) => ['items', itemId] as const;
const financeKey = (itemId: string) => [...itemKey(itemId), 'finance'] as const;

export const readFinance = (itemId: string): QueryEndpoint<Finance> =>
  defineQuery({
    operation: 'finance.read',
    path: root(itemId),
    cacheKey: [...financeKey(itemId), 'root'],
    schema: financeSchema,
  });

export const setSettings = (
  itemId: string,
  input: FinanceSettingsInput,
): CommandEndpoint<Finance> =>
  defineCommand({
    operation: 'finance.setSettings',
    method: 'PUT',
    path: root(itemId),
    body: input,
    schema: financeSchema,
    invalidates: [itemKey(itemId)],
  });

export const readAccounts = (itemId: string, month?: string): QueryEndpoint<FinanceAccounts> =>
  defineQuery({
    operation: 'finance.accounts',
    path: `${root(itemId)}/accounts`,
    query: month === undefined ? {} : { month },
    cacheKey: [...financeKey(itemId), 'accounts', month ?? ''],
    schema: financeAccountsSchema,
  });

export const createAccount = (
  itemId: string,
  input: FinanceAccountInput,
): CommandEndpoint<FinanceAccount> =>
  defineCommand({
    operation: 'finance.createAccount',
    method: 'POST',
    path: `${root(itemId)}/accounts`,
    body: input,
    schema: financeAccountSchema,
    invalidates: [itemKey(itemId)],
  });

export const setAccount = (
  itemId: string,
  accountId: string,
  input: FinanceAccountInput,
): CommandEndpoint<FinanceAccount> =>
  defineCommand({
    operation: 'finance.setAccount',
    method: 'PUT',
    path: `${root(itemId)}/accounts/${encodeURIComponent(accountId)}`,
    body: input,
    schema: financeAccountSchema,
    invalidates: [itemKey(itemId)],
  });

/** The schedule as configured beside the schedule with `overpayment` a month, when given. */
export const readLoan = (
  itemId: string,
  accountId: string,
  overpayment?: number,
): QueryEndpoint<LoanSchedule> =>
  defineQuery({
    operation: 'finance.loan',
    path: `${root(itemId)}/accounts/${encodeURIComponent(accountId)}/loan`,
    query: overpayment === undefined ? {} : { overpayment: String(overpayment) },
    cacheKey: [
      ...financeKey(itemId),
      'loan',
      accountId,
      overpayment === undefined ? '' : String(overpayment),
    ],
    schema: loanScheduleSchema,
  });

export const createLine = (itemId: string, input: BudgetLineInput): CommandEndpoint<BudgetLine> =>
  defineCommand({
    operation: 'finance.createLine',
    method: 'POST',
    path: `${root(itemId)}/lines`,
    body: input,
    schema: budgetLineSchema,
    invalidates: [itemKey(itemId)],
  });

export const setLine = (
  itemId: string,
  lineId: string,
  input: BudgetLineInput,
): CommandEndpoint<BudgetLine> =>
  defineCommand({
    operation: 'finance.setLine',
    method: 'PUT',
    path: `${root(itemId)}/lines/${encodeURIComponent(lineId)}`,
    body: input,
    schema: budgetLineSchema,
    invalidates: [itemKey(itemId)],
  });

export const listTransactions = (
  itemId: string,
  filter: FinanceTransactionsQuery = {},
): QueryEndpoint<FinanceTransactions> => {
  const query: Record<string, string> = {};
  if (filter.month !== undefined) query.month = filter.month;
  if (filter.accountId !== undefined) query.accountId = filter.accountId;
  if (filter.lineId !== undefined) query.lineId = filter.lineId;
  if (filter.unassigned) query.unassigned = 'true';
  if (filter.limit !== undefined) query.limit = String(filter.limit);
  return defineQuery({
    operation: 'finance.transactions',
    path: `${root(itemId)}/transactions`,
    query,
    cacheKey: [
      ...financeKey(itemId),
      'transactions',
      filter.month ?? '',
      filter.accountId ?? '',
      filter.lineId ?? '',
      filter.unassigned ? 'unassigned' : '',
      String(filter.limit ?? ''),
    ],
    schema: financeTransactionsSchema,
  });
};

/** Brings a line's actual for a month to `input.amount`; null transaction when it already was. */
export const setActual = (
  itemId: string,
  lineId: string,
  month: string,
  input: BudgetActualInput,
): CommandEndpoint<BudgetActual> =>
  defineCommand({
    operation: 'finance.setActual',
    method: 'POST',
    path: `${root(itemId)}/lines/${encodeURIComponent(lineId)}/months/${encodeURIComponent(month)}/actual`,
    body: input,
    schema: budgetActualSchema,
    invalidates: [itemKey(itemId)],
  });

export const createTransaction = (
  itemId: string,
  input: FinanceTransactionInput,
): CommandEndpoint<FinanceTransaction> =>
  defineCommand({
    operation: 'finance.createTransaction',
    method: 'POST',
    path: `${root(itemId)}/transactions`,
    body: input,
    schema: financeTransactionSchema,
    invalidates: [itemKey(itemId)],
  });

export const setTransaction = (
  itemId: string,
  transactionId: string,
  input: FinanceTransactionInput,
): CommandEndpoint<FinanceTransaction> =>
  defineCommand({
    operation: 'finance.setTransaction',
    method: 'PUT',
    path: `${root(itemId)}/transactions/${encodeURIComponent(transactionId)}`,
    body: input,
    schema: financeTransactionSchema,
    invalidates: [itemKey(itemId)],
  });

/** Deletes a transaction in an open month; the ordinary soft delete, so it can be restored. */
export const deleteTransaction = (
  itemId: string,
  transactionId: string,
): CommandEndpoint<undefined> =>
  defineCommand<undefined>({
    operation: 'finance.deleteTransaction',
    method: 'DELETE',
    path: `${root(itemId)}/transactions/${encodeURIComponent(transactionId)}`,
    schema: noContentSchema,
    invalidates: [itemKey(itemId)],
  });

/**
 * Lines by month; both bounds default to the current month, so one month is one call. With an
 * account, only that account's lines come back and every total is that account's alone.
 */
export const readBudget = (
  itemId: string,
  from?: string,
  to?: string,
  accountId?: string,
): QueryEndpoint<BudgetGrid> =>
  defineQuery({
    operation: 'finance.budget',
    path: `${root(itemId)}/budget`,
    query: {
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      ...(accountId === undefined ? {} : { accountId }),
    },
    cacheKey: [...financeKey(itemId), 'budget', from ?? '', to ?? '', accountId ?? ''],
    schema: budgetGridSchema,
  });

export const readCashFlow = (itemId: string): QueryEndpoint<CashFlow> =>
  defineQuery({
    operation: 'finance.cashFlow',
    path: `${root(itemId)}/cashflow`,
    cacheKey: [...financeKey(itemId), 'cashflow'],
    schema: cashFlowSchema,
  });

export const readDashboard = (itemId: string, month?: string): QueryEndpoint<FinanceDashboard> =>
  defineQuery({
    operation: 'finance.dashboard',
    path: `${root(itemId)}/dashboard`,
    query: month === undefined ? {} : { month },
    cacheKey: [...financeKey(itemId), 'dashboard', month ?? ''],
    schema: financeDashboardSchema,
  });

export const readMonth = (itemId: string, month: string): QueryEndpoint<MonthChecklist> =>
  defineQuery({
    operation: 'finance.month',
    path: `${root(itemId)}/months/${encodeURIComponent(month)}`,
    cacheKey: [...financeKey(itemId), 'month', month],
    schema: monthChecklistSchema,
  });

export const setMonth = (
  itemId: string,
  month: string,
  closed: boolean,
): CommandEndpoint<FinanceMonth> =>
  defineCommand({
    operation: 'finance.setMonth',
    method: 'PUT',
    path: `${root(itemId)}/months/${encodeURIComponent(month)}`,
    body: { closed },
    schema: financeMonthSchema,
    invalidates: [itemKey(itemId)],
  });

/** Idempotent: a line already posted for the month is counted, not posted again. */
export const postScheduled = (itemId: string, month: string): CommandEndpoint<PostScheduled> =>
  defineCommand({
    operation: 'finance.postScheduled',
    method: 'POST',
    path: `${root(itemId)}/months/${encodeURIComponent(month)}/post-scheduled`,
    schema: postScheduledSchema,
    invalidates: [itemKey(itemId)],
  });

/** With commit false nothing is written; the response says what a commit would do. */
export const importStatement = (
  itemId: string,
  input: FinanceImportInput,
): CommandEndpoint<FinanceImport> =>
  defineCommand({
    operation: 'finance.import',
    method: 'POST',
    path: `${root(itemId)}/import`,
    body: input,
    schema: financeImportSchema,
    invalidates: [itemKey(itemId)],
  });
