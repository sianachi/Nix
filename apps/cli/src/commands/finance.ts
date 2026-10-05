/** `nixctl finance`: set up a finance root, record against it, and read what Core derives. */

import { readFile } from 'node:fs/promises';
import {
  finance,
  type BudgetLineInput,
  type FinanceAccountInput,
  type FinanceAccountType,
} from '@nix/api-client';
import { z } from 'zod';
import { resolveSession, type SessionDeps } from './shared.ts';
import { printResult, type OutputOptions } from '../output.ts';

const MONTH = /^\d{4}-\d{2}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ACCOUNT_TYPES: readonly FinanceAccountType[] = [
  'current',
  'savings',
  'debit',
  'credit_card',
  'loan',
];

function parseMonth(value: string, flag: string): string {
  if (!MONTH.test(value)) throw new Error(`${flag} must be yyyy-MM - got '${value}'.`);
  const month = Number(value.slice(5, 7));
  if (month < 1 || month > 12) throw new Error(`${flag} must be a real month - got '${value}'.`);
  return value;
}

function parseDay(value: string, flag: string): string {
  if (!DAY.test(value)) throw new Error(`${flag} must be yyyy-MM-dd - got '${value}'.`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${flag} must be a real calendar day - got '${value}'.`);
  }
  return value;
}

/** An amount with at most two decimal places; Core refuses more, so this refuses first. */
function parseAmount(value: string, flag: string): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || Math.round(amount * 100) !== amount * 100) {
    throw new Error(`${flag} must be an amount with at most two decimal places - got '${value}'.`);
  }
  return amount;
}

function optionalAmount(value: string | undefined, flag: string): number | null {
  return value === undefined ? null : parseAmount(value, flag);
}

function parseWhole(value: string, flag: string, minimum: number): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum) {
    throw new Error(
      `${flag} must be a whole number of at least ${String(minimum)} - got '${value}'.`,
    );
  }
  return number;
}

export interface SetupOptions {
  readonly currency: string;
  readonly startMonth: string;
  readonly horizon: string;
  readonly openingCash: string;
  readonly emergencyMonths: string;
  readonly timezone: string;
}

export async function setup(
  profileName: string | undefined,
  rootId: string,
  options: SetupOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const input = {
    currency: options.currency.trim().toUpperCase(),
    startMonth: parseMonth(options.startMonth, '--start-month'),
    horizonMonths: parseWhole(options.horizon, '--horizon', 1),
    openingCash: parseAmount(options.openingCash, '--opening-cash'),
    emergencyFundMonths: Number(options.emergencyMonths),
    timezone: options.timezone.trim(),
  };
  if (!/^[A-Z]{3}$/.test(input.currency)) {
    throw new Error(`--currency must be a three-letter ISO code - got '${options.currency}'.`);
  }
  if (!Number.isFinite(input.emergencyFundMonths) || input.emergencyFundMonths < 0) {
    throw new Error(`--emergency-months must be zero or more - got '${options.emergencyMonths}'.`);
  }
  const session = await resolveSession(profileName, deps);
  printResult(await session.client.execute(finance.setSettings(rootId, input)), output);
}

export async function get(
  profileName: string | undefined,
  rootId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  printResult(await session.client.query(finance.readFinance(rootId)), output);
}

export interface AccountOptions {
  readonly name: string;
  readonly type: string;
  readonly limit?: string;
  readonly opening?: string;
  readonly settlesFrom?: string;
  readonly apr?: string;
  readonly payment?: string;
  readonly overpayment?: string;
  readonly target?: string;
  readonly archived?: boolean;
}

function accountInput(options: AccountOptions): FinanceAccountInput {
  if (!ACCOUNT_TYPES.includes(options.type as FinanceAccountType)) {
    throw new Error(`--type must be one of ${ACCOUNT_TYPES.join(', ')} - got '${options.type}'.`);
  }
  const apr = options.apr === undefined ? null : Number(options.apr);
  if (apr !== null && (!Number.isFinite(apr) || apr < 0 || apr > 200)) {
    throw new Error(`--apr is a percentage such as 11 - got '${String(options.apr)}'.`);
  }
  return {
    name: options.name.trim(),
    type: options.type as FinanceAccountType,
    limit: optionalAmount(options.limit, '--limit'),
    openingBalance: options.opening === undefined ? 0 : parseAmount(options.opening, '--opening'),
    settlesFrom: options.settlesFrom ?? null,
    apr: apr === null ? null : Math.round((apr / 100) * 1_000_000) / 1_000_000,
    payment: optionalAmount(options.payment, '--payment'),
    overpayment: optionalAmount(options.overpayment, '--overpayment'),
    target: optionalAmount(options.target, '--target'),
    archived: options.archived ?? false,
  };
}

export async function addAccount(
  profileName: string | undefined,
  rootId: string,
  options: AccountOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const input = accountInput(options);
  const session = await resolveSession(profileName, deps);
  printResult(await session.client.execute(finance.createAccount(rootId, input)), output);
}

export async function setAccount(
  profileName: string | undefined,
  rootId: string,
  accountId: string,
  options: AccountOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const input = accountInput(options);
  const session = await resolveSession(profileName, deps);
  printResult(await session.client.execute(finance.setAccount(rootId, accountId, input)), output);
}

export interface LineOptions {
  readonly name: string;
  readonly section: string;
  readonly flow: string;
  readonly account: string;
  readonly amount?: string;
  readonly scheduled?: boolean;
  readonly dueDay?: string;
  readonly loanAccount?: string;
  readonly override?: readonly string[];
  readonly archived?: boolean;
}

/** `--override 2027-04=2900`, repeatable. */
function parseOverrides(values: readonly string[] | undefined): Record<string, number> | null {
  if (values === undefined || values.length === 0) return null;
  const overrides: Record<string, number> = {};
  for (const value of values) {
    const [month, amount, ...rest] = value.split('=');
    if (month === undefined || amount === undefined || rest.length > 0) {
      throw new Error(`--override must be yyyy-MM=amount - got '${value}'.`);
    }
    overrides[parseMonth(month, '--override')] = parseAmount(amount, '--override');
  }
  return overrides;
}

function lineInput(options: LineOptions): BudgetLineInput {
  if (options.flow !== 'income' && options.flow !== 'expense') {
    throw new Error(`--flow must be income or expense - got '${options.flow}'.`);
  }
  return {
    name: options.name.trim(),
    section: options.section.trim(),
    flow: options.flow,
    accountId: options.account,
    amount: options.amount === undefined ? 0 : parseAmount(options.amount, '--amount'),
    overrides: parseOverrides(options.override),
    scheduled: options.scheduled ?? false,
    dueDay: options.dueDay === undefined ? null : parseWhole(options.dueDay, '--due-day', 1),
    loanAccount: options.loanAccount ?? null,
    archived: options.archived ?? false,
  };
}

export async function addLine(
  profileName: string | undefined,
  rootId: string,
  options: LineOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const input = lineInput(options);
  const session = await resolveSession(profileName, deps);
  printResult(await session.client.execute(finance.createLine(rootId, input)), output);
}

export async function setLine(
  profileName: string | undefined,
  rootId: string,
  lineId: string,
  options: LineOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const input = lineInput(options);
  const session = await resolveSession(profileName, deps);
  printResult(await session.client.execute(finance.setLine(rootId, lineId, input)), output);
}

export interface AddOptions {
  readonly amount: string;
  readonly description: string;
  readonly account: string;
  readonly line?: string;
  readonly date?: string;
  readonly cleared?: boolean;
}

export interface SetTransactionOptions {
  readonly amount: string;
  readonly description: string;
  readonly account: string;
  readonly line?: string;
  readonly date: string;
  readonly cleared: string;
  readonly unassigned?: boolean;
}

/** Records a transaction. The amount is signed: negative left the account. */
export async function add(
  profileName: string | undefined,
  rootId: string,
  options: AddOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const amount = parseAmount(options.amount, '--amount');
  if (amount === 0) throw new Error('--amount must be non-zero.');
  const date =
    options.date === undefined
      ? new Date().toISOString().slice(0, 10)
      : parseDay(options.date, '--date');
  const session = await resolveSession(profileName, deps);
  printResult(
    await session.client.execute(
      finance.createTransaction(rootId, {
        description: options.description.trim(),
        date,
        amount,
        accountId: options.account,
        lineId: options.line ?? null,
        cleared: options.cleared ?? false,
      }),
    ),
    output,
  );
}

/** Replaces a transaction. The API accepts the complete new record, so the date is required. */
export async function setTransaction(
  profileName: string | undefined,
  rootId: string,
  transactionId: string,
  options: SetTransactionOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const amount = parseAmount(options.amount, '--amount');
  if (amount === 0) throw new Error('--amount must be non-zero.');
  const date = parseDay(options.date, '--date');
  if (options.description.trim().length === 0) throw new Error('--description must not be empty.');
  if (options.line !== undefined && options.unassigned)
    throw new Error('Choose --line or --unassigned, not both.');
  if (options.line === undefined && !options.unassigned)
    throw new Error('Specify --line <lineId> or --unassigned.');
  if (options.cleared !== 'true' && options.cleared !== 'false')
    throw new Error('--cleared must be true or false.');
  const session = await resolveSession(profileName, deps);
  printResult(
    await session.client.execute(
      finance.setTransaction(rootId, transactionId, {
        description: options.description.trim(),
        date,
        amount,
        accountId: options.account,
        lineId: options.unassigned ? null : (options.line ?? null),
        cleared: options.cleared === 'true',
      }),
    ),
    output,
  );
}

export interface TransactionsOptions {
  readonly month?: string;
  readonly account?: string;
  readonly line?: string;
  readonly unassigned?: boolean;
  readonly limit?: string;
}

export async function transactions(
  profileName: string | undefined,
  rootId: string,
  options: TransactionsOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const filter = {
    ...(options.month === undefined ? {} : { month: parseMonth(options.month, '--month') }),
    ...(options.account === undefined ? {} : { accountId: options.account }),
    ...(options.line === undefined ? {} : { lineId: options.line }),
    ...(options.unassigned ? { unassigned: true } : {}),
    ...(options.limit === undefined ? {} : { limit: parseWhole(options.limit, '--limit', 1) }),
  };
  const session = await resolveSession(profileName, deps);
  printResult(await session.client.query(finance.listTransactions(rootId, filter)), output);
}

export async function budget(
  profileName: string | undefined,
  rootId: string,
  options: { readonly from?: string; readonly to?: string; readonly account?: string },
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const from = options.from === undefined ? undefined : parseMonth(options.from, '--from');
  const to = options.to === undefined ? undefined : parseMonth(options.to, '--to');
  if (from !== undefined && to !== undefined && from > to)
    throw new Error('--from must be on or before --to.');
  const session = await resolveSession(profileName, deps);
  printResult(
    await session.client.query(finance.readBudget(rootId, from, to, options.account)),
    output,
  );
}

export interface ActualOptions {
  readonly amount: string;
  readonly description?: string;
  readonly date?: string;
}

/** Brings a line's actual for a month to an amount; Core records the transaction that gets it there. */
export async function actual(
  profileName: string | undefined,
  rootId: string,
  lineId: string,
  value: string,
  options: ActualOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const month = parseMonth(value, 'month');
  const amount = parseAmount(options.amount, '--amount');
  if (amount < 0) throw new Error('--amount must be zero or more.');
  const date = options.date === undefined ? null : parseDay(options.date, '--date');
  if (date !== null && !date.startsWith(month)) throw new Error(`--date must fall in ${month}.`);
  const description = options.description?.trim();
  const session = await resolveSession(profileName, deps);
  printResult(
    await session.client.execute(
      finance.setActual(rootId, lineId, month, {
        amount,
        description: description === undefined || description === '' ? null : description,
        date,
      }),
    ),
    output,
  );
}

export async function deleteTransaction(
  profileName: string | undefined,
  rootId: string,
  transactionId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  await session.client.execute(finance.deleteTransaction(rootId, transactionId));
  printResult({ deleted: transactionId }, output);
}

export async function accounts(
  profileName: string | undefined,
  rootId: string,
  options: { readonly month?: string },
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const month = options.month === undefined ? undefined : parseMonth(options.month, '--month');
  const session = await resolveSession(profileName, deps);
  printResult(await session.client.query(finance.readAccounts(rootId, month)), output);
}

export async function loan(
  profileName: string | undefined,
  rootId: string,
  accountId: string,
  options: { readonly overpayment?: string },
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const overpayment =
    options.overpayment === undefined
      ? undefined
      : parseAmount(options.overpayment, '--overpayment');
  if (overpayment !== undefined && overpayment < 0)
    throw new Error('--overpayment must be zero or more.');
  const session = await resolveSession(profileName, deps);
  printResult(await session.client.query(finance.readLoan(rootId, accountId, overpayment)), output);
}

export async function cashFlow(
  profileName: string | undefined,
  rootId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  printResult(await session.client.query(finance.readCashFlow(rootId)), output);
}

export async function dashboard(
  profileName: string | undefined,
  rootId: string,
  options: { readonly month?: string },
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const month = options.month === undefined ? undefined : parseMonth(options.month, '--month');
  const session = await resolveSession(profileName, deps);
  printResult(await session.client.query(finance.readDashboard(rootId, month)), output);
}

/** Reads a month's checklist, or closes or reopens it when asked. */
export async function month(
  profileName: string | undefined,
  rootId: string,
  value: string,
  options: { readonly close?: boolean; readonly reopen?: boolean },
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const parsed = parseMonth(value, 'month');
  if (options.close && options.reopen) throw new Error('Choose --close or --reopen, not both.');
  const session = await resolveSession(profileName, deps);
  if (options.close || options.reopen) {
    printResult(
      await session.client.execute(finance.setMonth(rootId, parsed, options.close === true)),
      output,
    );
    return;
  }
  printResult(await session.client.query(finance.readMonth(rootId, parsed)), output);
}

export async function postScheduled(
  profileName: string | undefined,
  rootId: string,
  value: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const parsed = parseMonth(value, 'month');
  const session = await resolveSession(profileName, deps);
  printResult(await session.client.execute(finance.postScheduled(rootId, parsed)), output);
}

export interface ImportOptions {
  readonly account: string;
  readonly file: string;
  readonly commit?: boolean;
}

export async function importStatement(
  profileName: string | undefined,
  rootId: string,
  options: ImportOptions,
  output: OutputOptions,
  deps: SessionDeps & { readonly read?: (path: string) => Promise<string> } = {},
): Promise<void> {
  const read = deps.read ?? ((path: string) => readFile(path, 'utf8'));
  const csv = await read(options.file);
  if (csv.trim() === '') throw new Error(`${options.file} is empty.`);
  const session = await resolveSession(profileName, deps);
  printResult(
    await session.client.execute(
      finance.importStatement(rootId, {
        accountId: options.account,
        csv,
        commit: options.commit ?? false,
      }),
    ),
    output,
  );
}

const planSchema = z.object({
  settings: z.object({
    currency: z.string().length(3),
    startMonth: z.string().regex(MONTH),
    horizonMonths: z.int().positive(),
    openingCash: z.number(),
    emergencyFundMonths: z.number().nonnegative(),
    timezone: z.string().min(1),
  }),
  accounts: z.array(
    z.object({
      key: z.string().min(1),
      name: z.string().min(1),
      type: z.enum(ACCOUNT_TYPES),
      limit: z.number().nullable().default(null),
      openingBalance: z.number().default(0),
      settlesFrom: z.string().nullable().default(null),
      apr: z.number().nullable().default(null),
      payment: z.number().nullable().default(null),
      overpayment: z.number().nullable().default(null),
      target: z.number().nullable().default(null),
    }),
  ),
  lines: z.array(
    z.object({
      key: z.string().min(1).optional(),
      name: z.string().min(1),
      section: z.string().min(1),
      flow: z.enum(['income', 'expense']),
      account: z.string().min(1),
      amount: z.number().default(0),
      overrides: z.record(z.string().regex(MONTH), z.number()).default({}),
      scheduled: z.boolean().default(false),
      dueDay: z.int().min(1).max(31).nullable().default(null),
      loanAccount: z.string().nullable().default(null),
    }),
  ),
  transactions: z
    .array(
      z.object({
        key: z.string().min(1),
        date: z.string(),
        description: z.string().min(1),
        amount: z.number(),
        account: z.string().min(1),
        line: z.string().min(1).nullable().optional().default(null),
        cleared: z.boolean().default(false),
      }),
    )
    .default([]),
  closedMonths: z.array(z.string().regex(MONTH)).default([]),
  zeroActivityMonths: z.array(z.string().regex(MONTH)).default([]),
});

export type FinancePlan = z.infer<typeof planSchema>;

/**
 * Seeds a root from a plan file: settings, accounts, lines, actual transactions, then closed months.
 *
 * Accounts are named by a key inside the file so lines and cards can point at each other before
 * anything has an identifier; the seeder resolves keys to the identifiers Core mints. Accounts
 * that settle from another are created after the one they settle from, whatever order the file
 * lists them in.
 */
export async function seed(
  profileName: string | undefined,
  rootId: string,
  options: { readonly file: string },
  output: OutputOptions,
  deps: SessionDeps & { readonly read?: (path: string) => Promise<string> } = {},
): Promise<void> {
  const read = deps.read ?? ((path: string) => readFile(path, 'utf8'));
  const source = await read(options.file);
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new Error(`${options.file} is not valid JSON.`);
  }
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `${options.file} is not a finance plan: ${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`,
    );
  }
  const plan = parsed.data;
  const accountByKey = new Map<string, (typeof plan.accounts)[number]>();
  for (const account of plan.accounts) {
    if (!account.name.trim() || account.name.length > 120)
      throw new Error(`Account '${account.key}' needs a name of at most 120 characters.`);
    if (accountByKey.has(account.key)) throw new Error(`Duplicate account key '${account.key}'.`);
    accountByKey.set(account.key, account);
  }
  const lineKeys = plan.lines.map((line) => line.key ?? line.name);
  const lineByKey = new Map<string, (typeof plan.lines)[number]>();
  for (const [index, line] of plan.lines.entries()) {
    const key = lineKeys[index];
    if (key === undefined) continue;
    if (lineByKey.has(key)) throw new Error(`Duplicate line key '${key}'.`);
    lineByKey.set(key, line);
  }
  for (const account of plan.accounts) {
    if (!isPlanMoney(account.openingBalance))
      throw new Error(`Account '${account.key}' has an invalid openingBalance.`);
    if (account.limit !== null && (!isPlanMoney(account.limit) || account.limit <= 0))
      throw new Error(
        `Account '${account.key}' limit must be a positive amount with at most two decimal places.`,
      );
    if (account.target !== null && (!isPlanMoney(account.target) || account.target <= 0))
      throw new Error(
        `Account '${account.key}' target must be a positive amount with at most two decimal places.`,
      );
    if (account.type !== 'current' && account.openingBalance < 0)
      throw new Error(
        `Account '${account.key}' openingBalance cannot be negative for ${account.type}.`,
      );
    if (account.type === 'credit_card' && account.settlesFrom === null)
      throw new Error(`Credit card '${account.key}' must name settlesFrom.`);
    if (account.type === 'loan') {
      if (
        account.apr === null ||
        !Number.isFinite(account.apr) ||
        account.apr < 0 ||
        account.apr > 2 ||
        Math.round(account.apr * 1_000_000) !== account.apr * 1_000_000
      )
        throw new Error(
          `Loan '${account.key}' needs an APR fraction from 0 to 2 with at most six decimal places.`,
        );
      if (account.payment === null || !isPlanMoney(account.payment) || account.payment <= 0)
        throw new Error(`Loan '${account.key}' needs a positive monthly payment.`);
      if (
        account.overpayment !== null &&
        (!isPlanMoney(account.overpayment) || account.overpayment < 0)
      )
        throw new Error(
          `Loan '${account.key}' overpayment must be zero or more, with at most two decimal places.`,
        );
    } else if (account.apr !== null || account.payment !== null || account.overpayment !== null) {
      throw new Error(
        `Only loan accounts may define apr, payment or overpayment ('${account.key}').`,
      );
    }
    if (account.apr !== null && account.type === 'loan' && !Number.isFinite(account.apr))
      throw new Error(`Loan '${account.key}' has an invalid APR.`);
    if (account.settlesFrom !== null && !accountByKey.has(account.settlesFrom)) {
      throw new Error(
        `Account '${account.key}' settles from unknown account '${account.settlesFrom}'.`,
      );
    }
    if (account.settlesFrom === account.key)
      throw new Error(`Account '${account.key}' cannot settle from itself.`);
  }
  const accountsInOrder: typeof plan.accounts = [];
  const pending = [...plan.accounts];
  const resolved = new Set<string>();
  while (pending.length > 0) {
    const index = pending.findIndex(
      (account) => account.settlesFrom === null || resolved.has(account.settlesFrom),
    );
    if (index < 0) throw new Error('Accounts settle from each other in a cycle.');
    const [account] = pending.splice(index, 1);
    if (account === undefined) break;
    accountsInOrder.push(account);
    resolved.add(account.key);
  }
  const start = plan.settings.startMonth;
  parseMonth(start, 'settings.startMonth');
  const end = monthAfter(start, plan.settings.horizonMonths - 1);
  if (!isPlanMoney(plan.settings.openingCash))
    throw new Error('settings.openingCash must have at most two decimal places.');
  if (plan.settings.horizonMonths > 120)
    throw new Error('settings.horizonMonths must be at most 120.');
  if (Number(start.slice(0, 4)) < 1970 || Number(end.slice(0, 4)) > 2200)
    throw new Error('The finance plan window must be between 1970 and 2200.');
  if (!/^[A-Z]{3}$/.test(plan.settings.currency))
    throw new Error('settings.currency must be a three-letter uppercase code.');
  if (
    plan.settings.emergencyFundMonths > 36 ||
    Math.round(plan.settings.emergencyFundMonths * 10) !== plan.settings.emergencyFundMonths * 10
  )
    throw new Error('settings.emergencyFundMonths must be from 0 to 36, to one decimal place.');
  if (plan.settings.timezone.length > 128)
    throw new Error('settings.timezone must be at most 128 characters.');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: plan.settings.timezone });
  } catch {
    throw new Error(`Invalid timezone '${plan.settings.timezone}'.`);
  }
  for (const account of plan.accounts) {
    if (account.settlesFrom !== null) {
      const source = accountByKey.get(account.settlesFrom);
      if (source !== undefined && (source.type === 'credit_card' || source.type === 'loan'))
        throw new Error(`Account '${account.key}' cannot settle from a card or loan.`);
    }
  }
  for (const line of plan.lines) {
    if (!line.name.trim() || line.name.length > 120)
      throw new Error(`Line '${line.name}' needs a name of at most 120 characters.`);
    if (!line.section.trim() || line.section.length > 60)
      throw new Error(`Line '${line.name}' needs a section of at most 60 characters.`);
    if (!accountByKey.has(line.account))
      throw new Error(`Line '${line.name}' names unknown account '${line.account}'.`);
    const account = accountByKey.get(line.account);
    if (account?.type === 'loan')
      throw new Error(`Line '${line.name}' cannot be paid from a loan account.`);
    if (line.loanAccount !== null && !accountByKey.has(line.loanAccount)) {
      throw new Error(`Line '${line.name}' names unknown loan '${line.loanAccount}'.`);
    }
    if (line.loanAccount !== null && accountByKey.get(line.loanAccount)?.type !== 'loan')
      throw new Error(`Line '${line.name}' must reference a loan account as loanAccount.`);
    if (line.loanAccount !== null && line.flow === 'income')
      throw new Error(`Loan line '${line.name}' must be an expense.`);
    if (!isPlanMoney(line.amount) || line.amount < 0)
      throw new Error(
        `Line '${line.name}' amount must be zero or more, with at most two decimal places.`,
      );
    for (const [month, amount] of Object.entries(line.overrides)) {
      parseMonth(month, `Line '${line.name}' override`);
      if (!isPlanMoney(amount) || amount < 0)
        throw new Error(
          `Line '${line.name}' override for ${month} must be zero or more, with at most two decimal places.`,
        );
    }
    if (Object.keys(line.overrides).length > 240)
      throw new Error(`Line '${line.name}' has more than 240 month overrides.`);
    if (line.scheduled && line.dueDay === null)
      throw new Error(`Scheduled line '${line.name}' must define dueDay.`);
  }
  const transactionKeys = new Set<string>();
  const transactionsByMonth = new Set<string>();
  for (const transaction of plan.transactions) {
    if (transactionKeys.has(transaction.key))
      throw new Error(`Duplicate transaction key '${transaction.key}'.`);
    transactionKeys.add(transaction.key);
    parseDay(transaction.date, `Transaction '${transaction.key}' date`);
    const year = Number(transaction.date.slice(0, 4));
    if (year < 1970 || year > 2200)
      throw new Error(`Transaction '${transaction.key}' date must be between 1970 and 2200.`);
    const transactionMonth = transaction.date.slice(0, 7);
    if (transactionMonth < start || transactionMonth > end)
      throw new Error(
        `Transaction '${transaction.key}' falls outside the finance plan window (${start} to ${end}).`,
      );
    if (!isPlanMoney(transaction.amount) || transaction.amount === 0)
      throw new Error(
        `Transaction '${transaction.key}' amount must be non-zero, with at most two decimal places.`,
      );
    if (transaction.description.trim().length === 0 || transaction.description.length > 200)
      throw new Error(
        `Transaction '${transaction.key}' needs a description of at most 200 characters.`,
      );
    const account = accountByKey.get(transaction.account);
    if (account === undefined)
      throw new Error(
        `Transaction '${transaction.key}' names unknown account '${transaction.account}'.`,
      );
    if (account.type === 'loan')
      throw new Error(
        `Transaction '${transaction.key}' cannot be recorded on loan account '${transaction.account}'.`,
      );
    if (transaction.line !== null) {
      const line = lineByKey.get(transaction.line);
      if (line === undefined)
        throw new Error(
          `Transaction '${transaction.key}' names unknown line '${transaction.line}'.`,
        );
      if (line.account !== transaction.account)
        throw new Error(
          `Transaction '${transaction.key}' account '${transaction.account}' does not match line '${transaction.line}' account '${line.account}'.`,
        );
      if (line.flow === 'income' && transaction.amount < 0)
        throw new Error(`Income transaction '${transaction.key}' must have a positive amount.`);
    }
    transactionsByMonth.add(transactionMonth);
  }
  const closedMonths = new Set<string>();
  for (const closed of plan.closedMonths) {
    parseMonth(closed, 'closedMonths');
    if (closedMonths.has(closed)) throw new Error(`Duplicate closed month '${closed}'.`);
    closedMonths.add(closed);
    if (closed < start || closed > end)
      throw new Error(
        `Closed month '${closed}' falls outside the finance plan window (${start} to ${end}).`,
      );
  }
  const zeroActivityMonths = new Set<string>();
  for (const zero of plan.zeroActivityMonths) {
    parseMonth(zero, 'zeroActivityMonths');
    if (zeroActivityMonths.has(zero)) throw new Error(`Duplicate zero-activity month '${zero}'.`);
    if (transactionsByMonth.has(zero))
      throw new Error(`Month '${zero}' has transactions and cannot be declared zero-activity.`);
    if (!closedMonths.has(zero))
      throw new Error(`Zero-activity month '${zero}' must also be listed in closedMonths.`);
    zeroActivityMonths.add(zero);
  }
  for (const closed of closedMonths) {
    if (!transactionsByMonth.has(closed) && !zeroActivityMonths.has(closed)) {
      throw new Error(
        `Closed month '${closed}' needs at least one transaction or an explicit zeroActivityMonths entry.`,
      );
    }
  }
  const session = await resolveSession(profileName, deps);
  const client = session.client;
  try {
    const existing = await client.query(finance.readFinance(rootId));
    throw new Error(
      `Finance root '${rootId}' is already configured${existing.transactionCount > 0 || existing.accounts.length > 0 || existing.lines.length > 0 ? ' or contains data' : ''}; seed only an unconfigured root.`,
    );
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'finance.not_configured') {
      // An unconfigured root is the only safe seed target.
    } else {
      throw error;
    }
  }
  const ids = new Map<string, string>();
  const lines = new Map<string, string>();
  let stage = 'setting root settings';
  try {
    await client.execute(finance.setSettings(rootId, plan.settings));
    for (const account of accountsInOrder) {
      stage = `creating account '${account.key}'`;
      const created = await client.execute(
        finance.createAccount(rootId, {
          name: account.name,
          type: account.type,
          limit: account.limit,
          openingBalance: account.openingBalance,
          settlesFrom: account.settlesFrom === null ? null : (ids.get(account.settlesFrom) ?? null),
          apr: account.apr,
          payment: account.payment,
          overpayment: account.overpayment,
          target: account.target,
        }),
      );
      ids.set(account.key, created.id);
    }
    for (const [index, line] of plan.lines.entries()) {
      const key = lineKeys[index] ?? line.name;
      stage = `creating line '${key}'`;
      const created = await client.execute(
        finance.createLine(rootId, {
          name: line.name,
          section: line.section,
          flow: line.flow,
          accountId: ids.get(line.account) ?? '',
          amount: line.amount,
          overrides: line.overrides,
          scheduled: line.scheduled,
          dueDay: line.dueDay,
          loanAccount: line.loanAccount === null ? null : (ids.get(line.loanAccount) ?? null),
        }),
      );
      lines.set(key, created.id);
    }
    for (const transaction of plan.transactions) {
      stage = `importing transaction '${transaction.key}'`;
      await client.execute(
        finance.createTransaction(rootId, {
          description: transaction.description.trim(),
          date: transaction.date,
          amount: transaction.amount,
          accountId: ids.get(transaction.account) ?? '',
          lineId: transaction.line === null ? null : (lines.get(transaction.line) ?? null),
          cleared: transaction.cleared,
        }),
      );
    }
    for (const closed of plan.closedMonths) {
      stage = `closing month '${closed}'`;
      await client.execute(finance.setMonth(rootId, closed, true));
    }
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Finance seed stopped while ${stage}. The root may now contain partial seed data, and earlier closed months may already be saved; later stages were not attempted. Inspect and recover the root manually in Finance, or use a fresh root. Seed refuses configured roots on retry. Cause: ${cause}`,
      { cause: error },
    );
  }
  printResult(
    {
      rootId,
      accounts: Object.fromEntries(ids),
      lines: Object.fromEntries(lines),
      transactions: plan.transactions.length,
      closedMonths: plan.closedMonths,
    },
    output,
  );
}

function isPlanMoney(value: number): boolean {
  return Number.isFinite(value) && Math.round(value * 100) === value * 100;
}

function monthAfter(month: string, count: number): string {
  const date = new Date(`${month}-01T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + count);
  return date.toISOString().slice(0, 7);
}
