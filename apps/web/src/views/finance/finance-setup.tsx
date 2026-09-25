import { Button, Dialog, Field, Input, Select, Text } from '@nix/ui';
import type {
  BudgetLine,
  BudgetLineInput,
  Finance,
  FinanceAccount,
  FinanceAccountInput,
  FinanceAccountType,
} from '@nix/api-client';
import { useState, type SyntheticEvent, type ReactNode } from 'react';
import { localTimeZone } from '../../lib/date-format';
import { WriteError } from './finance-shared';
import { parseAmount } from './money';
import type { FinanceState } from './use-finance';

// Three forms, one shape: local draft state, a submit that hands the draft to Core and shows
// what Core said if it refused. Validation lives on the server; these forms only turn typed
// text into numbers and refuse to send something that is not one.

function readerTimezone(): string {
  try {
    return localTimeZone();
  } catch {
    return 'UTC';
  }
}

function thisMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

interface SettingsDialogProps {
  readonly state: FinanceState;
  readonly finance: Finance | null;
  readonly open: boolean;
  readonly onClose: () => void;
}

// Each dialog mounts its form only while open, so the form's state starts from the record it
// was opened for and is thrown away on close; nothing has to be reset in an effect.
export function SettingsDialog(props: SettingsDialogProps): ReactNode {
  return props.open ? <SettingsForm {...props} /> : null;
}

function SettingsForm({ state, finance, onClose }: SettingsDialogProps): ReactNode {
  const settings = finance?.settings;
  const [currency, setCurrency] = useState(settings?.currency ?? 'GBP');
  const [startMonth, setStartMonth] = useState(settings?.startMonth ?? thisMonth());
  const [horizon, setHorizon] = useState(String(settings?.horizonMonths ?? 17));
  const [openingCash, setOpeningCash] = useState(String(settings?.openingCash ?? 0));
  const [emergency, setEmergency] = useState(String(settings?.emergencyFundMonths ?? 3));
  const [timezone, setTimezone] = useState(settings?.timezone ?? readerTimezone());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault();
    const cash = parseAmount(openingCash);
    const months = Number(horizon);
    const buffer = Number(emergency);
    if (cash === null) {
      setError('Opening cash must be an amount.');
      return;
    }
    if (!Number.isInteger(months) || months < 1) {
      setError('The horizon is a whole number of months.');
      return;
    }
    if (!Number.isFinite(buffer) || buffer < 0) {
      setError('The emergency fund is a number of months.');
      return;
    }
    setBusy(true);
    const refusal = await state.setSettings({
      currency: currency.trim().toUpperCase(),
      startMonth,
      horizonMonths: months,
      openingCash: cash,
      emergencyFundMonths: buffer,
      timezone: timezone.trim(),
    });
    setBusy(false);
    setError(refusal);
    if (refusal === null) onClose();
  };

  return (
    <Dialog
      open
      title={finance === null ? 'Set up finances' : 'Finance settings'}
      onClose={onClose}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <Field label="Currency" hint="A three-letter code such as GBP.">
          {(control) => (
            <Input
              {...control}
              value={currency}
              maxLength={3}
              onChange={(event) => {
                setCurrency(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label="First month of the plan" hint="Opening balances are as at the day before it.">
          {(control) => (
            <Input
              {...control}
              type="month"
              value={startMonth}
              onChange={(event) => {
                setStartMonth(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Months to plan" hint="How far the budget and the projection run.">
          {(control) => (
            <Input
              {...control}
              type="number"
              min={1}
              max={120}
              value={horizon}
              onChange={(event) => {
                setHorizon(event.target.value);
              }}
            />
          )}
        </Field>
        <Field
          label="Cash at the start"
          hint="Across current and savings accounts, before the first month's card bill goes out."
        >
          {(control) => (
            <Input
              {...control}
              inputMode="decimal"
              value={openingCash}
              onChange={(event) => {
                setOpeningCash(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Emergency fund, in months of outgoings">
          {(control) => (
            <Input
              {...control}
              inputMode="decimal"
              value={emergency}
              onChange={(event) => {
                setEmergency(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Timezone" hint="Where today is decided, such as Europe/London.">
          {(control) => (
            <Input
              {...control}
              value={timezone}
              onChange={(event) => {
                setTimezone(event.target.value);
              }}
            />
          )}
        </Field>
        <WriteError message={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {finance === null ? 'Create' : 'Save'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

const ACCOUNT_TYPES: readonly { readonly value: FinanceAccountType; readonly label: string }[] = [
  { value: 'current', label: 'Current account' },
  { value: 'savings', label: 'Savings account' },
  { value: 'debit', label: 'Debit card or prepaid' },
  { value: 'credit_card', label: 'Credit card, paid in full' },
  { value: 'loan', label: 'Loan' },
];

export function accountTypeLabel(type: FinanceAccountType): string {
  return ACCOUNT_TYPES.find((option) => option.value === type)?.label ?? type;
}

interface AccountDialogProps {
  readonly state: FinanceState;
  readonly finance: Finance;
  /** The account to edit, or null to add one. */
  readonly account: FinanceAccount | null;
  readonly open: boolean;
  readonly onClose: () => void;
}

export function AccountDialog(props: AccountDialogProps): ReactNode {
  return props.open ? <AccountForm {...props} /> : null;
}

function AccountForm({ state, finance, account, onClose }: AccountDialogProps): ReactNode {
  const cashAccounts = finance.accounts.filter(
    (candidate) =>
      candidate.type !== 'credit_card' && candidate.type !== 'loan' && !candidate.archived,
  );
  const [name, setName] = useState(account?.name ?? '');
  const [type, setType] = useState<FinanceAccountType>(account?.type ?? 'current');
  const [limit, setLimit] = useState(account?.limit == null ? '' : String(account.limit));
  const [opening, setOpening] = useState(String(account?.openingBalance ?? 0));
  const [settlesFrom, setSettlesFrom] = useState(account?.settlesFrom ?? cashAccounts[0]?.id ?? '');
  const [apr, setApr] = useState(account?.apr == null ? '' : String(account.apr * 100));
  const [payment, setPayment] = useState(account?.payment == null ? '' : String(account.payment));
  const [overpayment, setOverpayment] = useState(String(account?.overpayment ?? 0));
  const [target, setTarget] = useState(account?.target == null ? '' : String(account.target));
  const [archived, setArchived] = useState(account?.archived ?? false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault();
    const openingBalance = parseAmount(opening);
    if (openingBalance === null) {
      setError('The opening balance must be an amount.');
      return;
    }
    const optional = (text: string): number | null =>
      text.trim() === '' ? null : parseAmount(text);
    const rate = apr.trim() === '' ? null : Number(apr) / 100;
    const input: FinanceAccountInput = {
      name: name.trim(),
      type,
      limit: type === 'credit_card' ? optional(limit) : null,
      openingBalance,
      settlesFrom: type === 'credit_card' ? (settlesFrom === '' ? null : settlesFrom) : null,
      apr:
        type === 'loan'
          ? rate === null || !Number.isFinite(rate)
            ? null
            : Math.round(rate * 1_000_000) / 1_000_000
          : null,
      payment: type === 'loan' ? optional(payment) : null,
      overpayment: type === 'loan' ? (optional(overpayment) ?? 0) : null,
      target: type === 'savings' ? optional(target) : null,
      archived,
    };
    setBusy(true);
    const refusal =
      account === null
        ? await state.createAccount(input)
        : await state.setAccount(account.id, input);
    setBusy(false);
    setError(refusal);
    if (refusal === null) onClose();
  };

  return (
    <Dialog
      open
      title={account === null ? 'Add an account' : `Edit ${account.name}`}
      onClose={onClose}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <Field label="Name">
          {(control) => (
            <Input
              {...control}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Type">
          {(control) => (
            <Select
              {...control}
              value={type}
              onChange={(event) => {
                setType(event.target.value as FinanceAccountType);
              }}
            >
              {ACCOUNT_TYPES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label={
            type === 'credit_card'
              ? 'Statement balance carried into the first month'
              : type === 'loan'
                ? 'Balance owed at the start'
                : 'Balance at the start'
          }
          {...(type === 'credit_card'
            ? { hint: 'Collected in the first month of the plan.' }
            : type === 'loan'
              ? { hint: 'The day before the first month of the plan.' }
              : {})}
        >
          {(control) => (
            <Input
              {...control}
              inputMode="decimal"
              value={opening}
              onChange={(event) => {
                setOpening(event.target.value);
              }}
            />
          )}
        </Field>
        {type === 'credit_card' ? (
          <>
            <Field label="Credit limit" hint="Drives the utilisation check; keep it under 30%.">
              {(control) => (
                <Input
                  {...control}
                  inputMode="decimal"
                  value={limit}
                  onChange={(event) => {
                    setLimit(event.target.value);
                  }}
                />
              )}
            </Field>
            <Field label="Paid in full from">
              {(control) => (
                <Select
                  {...control}
                  value={settlesFrom}
                  onChange={(event) => {
                    setSettlesFrom(event.target.value);
                  }}
                >
                  {cashAccounts.length === 0 ? (
                    <option value="">Add a current account first</option>
                  ) : null}
                  {cashAccounts.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </>
        ) : null}
        {type === 'loan' ? (
          <>
            <Field label="Annual rate, percent" hint="11 for eleven percent.">
              {(control) => (
                <Input
                  {...control}
                  inputMode="decimal"
                  value={apr}
                  onChange={(event) => {
                    setApr(event.target.value);
                  }}
                />
              )}
            </Field>
            <Field label="Standard monthly payment">
              {(control) => (
                <Input
                  {...control}
                  inputMode="decimal"
                  value={payment}
                  onChange={(event) => {
                    setPayment(event.target.value);
                  }}
                />
              )}
            </Field>
            <Field
              label="Overpayment each month"
              hint="Try a figure on the Accounts page before committing to it here."
            >
              {(control) => (
                <Input
                  {...control}
                  inputMode="decimal"
                  value={overpayment}
                  onChange={(event) => {
                    setOverpayment(event.target.value);
                  }}
                />
              )}
            </Field>
          </>
        ) : null}
        {type === 'savings' ? (
          <Field label="Saving towards" hint="Optional. Progress is shown against it.">
            {(control) => (
              <Input
                {...control}
                inputMode="decimal"
                value={target}
                onChange={(event) => {
                  setTarget(event.target.value);
                }}
              />
            )}
          </Field>
        ) : null}
        {account === null ? null : (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={archived}
              onChange={(event) => {
                setArchived(event.target.checked);
              }}
            />
            <Text as="span" variant="bodySmall">
              Archived: kept for history, offered nowhere new
            </Text>
          </label>
        )}
        <WriteError message={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {account === null ? 'Add account' : 'Save'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

interface LineDialogProps {
  readonly state: FinanceState;
  readonly finance: Finance;
  /** The line to edit, or null to add one. */
  readonly line: BudgetLine | null;
  readonly open: boolean;
  readonly onClose: () => void;
}

export function LineDialog(props: LineDialogProps): ReactNode {
  return props.open ? <LineForm {...props} /> : null;
}

function LineForm({ state, finance, line, onClose }: LineDialogProps): ReactNode {
  const spendable = finance.accounts.filter(
    (account) => account.type !== 'loan' && !account.archived,
  );
  const loans = finance.accounts.filter((account) => account.type === 'loan' && !account.archived);
  const sections = [...new Set(finance.lines.map((candidate) => candidate.section))];
  const [name, setName] = useState(line?.name ?? '');
  const [section, setSection] = useState(line?.section ?? '');
  const [flow, setFlow] = useState<'income' | 'expense'>(line?.flow ?? 'expense');
  const [accountId, setAccountId] = useState(line?.accountId ?? spendable[0]?.id ?? '');
  const [amount, setAmount] = useState(String(line?.amount ?? 0));
  const [scheduled, setScheduled] = useState(line?.scheduled ?? false);
  const [dueDay, setDueDay] = useState(String(line?.dueDay ?? 1));
  const [loanAccount, setLoanAccount] = useState(line?.loanAccount ?? '');
  const [archived, setArchived] = useState(line?.archived ?? false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault();
    const planned = parseAmount(amount);
    if (planned === null) {
      setError('The planned amount must be an amount.');
      return;
    }
    const day = Number(dueDay);
    const input: BudgetLineInput = {
      name: name.trim(),
      section: section.trim(),
      flow,
      accountId,
      amount: planned,
      overrides: line?.overrides ?? null,
      scheduled,
      dueDay: scheduled ? (Number.isInteger(day) ? day : null) : null,
      loanAccount: loanAccount === '' ? null : loanAccount,
      archived,
    };
    setBusy(true);
    const refusal =
      line === null ? await state.createLine(input) : await state.setLine(line.id, input);
    setBusy(false);
    setError(refusal);
    if (refusal === null) onClose();
  };

  return (
    <Dialog
      open
      title={line === null ? 'Add a budget line' : `Edit ${line.name}`}
      onClose={onClose}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <Field label="Name" hint="Rent, Groceries, Salary.">
          {(control) => (
            <Input
              {...control}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Section" hint="The heading it sits under: Housing, Commitments, Income.">
          {(control) => (
            <>
              <Input
                {...control}
                list="finance-line-sections"
                value={section}
                onChange={(event) => {
                  setSection(event.target.value);
                }}
              />
              <datalist id="finance-line-sections">
                {sections.map((known) => (
                  <option key={known} value={known} />
                ))}
              </datalist>
            </>
          )}
        </Field>
        <Field label="Flow">
          {(control) => (
            <Select
              {...control}
              value={flow}
              onChange={(event) => {
                setFlow(event.target.value === 'income' ? 'income' : 'expense');
              }}
            >
              <option value="expense">Expense</option>
              <option value="income">Income</option>
            </Select>
          )}
        </Field>
        <Field label={flow === 'income' ? 'Paid into' : 'Paid from'}>
          {(control) => (
            <Select
              {...control}
              value={accountId}
              onChange={(event) => {
                setAccountId(event.target.value);
              }}
            >
              {spendable.length === 0 ? <option value="">Add an account first</option> : null}
              {spendable.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {flow === 'expense' && loans.length > 0 ? (
          <Field
            label="Loan repayment for"
            hint="When set, the plan is that loan's payment plus overpayment."
          >
            {(control) => (
              <Select
                {...control}
                value={loanAccount}
                onChange={(event) => {
                  setLoanAccount(event.target.value);
                }}
              >
                <option value="">Not a loan repayment</option>
                {loans.map((loan) => (
                  <option key={loan.id} value={loan.id}>
                    {loan.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
        {loanAccount === '' ? (
          <Field label="Planned amount each month" hint="Change one month from the Budget page.">
            {(control) => (
              <Input
                {...control}
                inputMode="decimal"
                value={amount}
                onChange={(event) => {
                  setAmount(event.target.value);
                }}
              />
            )}
          </Field>
        ) : null}
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={scheduled}
            onChange={(event) => {
              setScheduled(event.target.checked);
            }}
          />
          <Text as="span" variant="bodySmall">
            Leaves on its own, as a direct debit or subscription; post it from the plan
          </Text>
        </label>
        {scheduled ? (
          <Field label="Day of the month it goes out">
            {(control) => (
              <Input
                {...control}
                type="number"
                min={1}
                max={31}
                value={dueDay}
                onChange={(event) => {
                  setDueDay(event.target.value);
                }}
              />
            )}
          </Field>
        ) : null}
        {line === null ? null : (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={archived}
              onChange={(event) => {
                setArchived(event.target.checked);
              }}
            />
            <Text as="span" variant="bodySmall">
              Archived: planned no further, transactions still count
            </Text>
          </label>
        )}
        <WriteError message={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {line === null ? 'Add line' : 'Save'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
