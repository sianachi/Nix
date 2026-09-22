import { Button, Dialog, Field, Input, Segmented, Tag, Text } from '@nix/ui';
import {
  finance as financeApi,
  type BudgetGrid,
  type BudgetLine,
  type Finance,
} from '@nix/api-client';
import { useMemo, useState, type SyntheticEvent, type ReactNode } from 'react';
import { ErrorPanel, LoadingPanel, PartialNotice } from '../../components/states/status-panels';
import { LineDialog } from './finance-setup';
import { Money, SectionHeading, WriteError } from './finance-shared';
import { formatMonth, parseAmount, shiftMonth } from './money';
import { useFinanceQuery, type FinanceState } from './use-finance';

type Figure = 'plan' | 'actual' | 'left';
type Span = 'month' | 'year';

const FIGURES: readonly { readonly value: Figure; readonly label: string }[] = [
  { value: 'plan', label: 'Plan' },
  { value: 'actual', label: 'Actual' },
  { value: 'left', label: 'Left' },
];

/**
 * The workbook's Budget, Actual and Variance sheets as one grid.
 *
 * One month shows plan, actual and what is left side by side; the year view shows one figure
 * across every month in the horizon window. Every number is Core's; a cell with transactions
 * behind it says how many, and the line's plan for one month can be changed in place.
 */
export function FinanceBudget({
  state,
  finance,
  month,
  onMonth,
}: {
  readonly state: FinanceState;
  readonly finance: Finance;
  readonly month: string;
  readonly onMonth: (month: string) => void;
}): ReactNode {
  const currency = finance.settings.currency;
  const [span, setSpan] = useState<Span>('month');
  const [figure, setFigure] = useState<Figure>('actual');
  const [editing, setEditing] = useState<BudgetLine | null | 'new'>(null);
  const [override, setOverride] = useState<{ line: BudgetLine; month: string } | null>(null);
  // A year window: up to twelve months, starting at the selected month, inside the horizon.
  const from = span === 'month' ? month : month;
  const to =
    span === 'month'
      ? month
      : ([shiftMonth(month, 11), finance.settings.endMonth].sort()[0] ?? month);
  const itemId = finance.itemId;
  const endpoint = useMemo(() => financeApi.readBudget(itemId, from, to), [itemId, from, to]);
  const query = useFinanceQuery<BudgetGrid>(endpoint, state.generation);
  if (query.data === null) {
    return query.status === 'error' ? (
      <ErrorPanel title="The budget could not be loaded" detail={query.error ?? ''} />
    ) : (
      <LoadingPanel label="budget" />
    );
  }
  const grid = query.data;
  const value = (
    cell: BudgetGrid['sections'][number]['totals'][number],
    flow: 'income' | 'expense',
  ): number =>
    figure === 'plan'
      ? cell.plan
      : figure === 'actual'
        ? cell.actual
        : flow === 'income'
          ? cell.variance
          : -cell.variance;
  return (
    <div className="flex flex-col gap-4">
      <SectionHeading
        id="finance-budget-title"
        title="Budget"
        detail={
          span === 'month'
            ? `${formatMonth(month, 'long')}: plan, actual and what is left on each line.`
            : `${formatMonth(from)} to ${formatMonth(to)}: ${FIGURES.find((option) => option.value === figure)?.label.toLowerCase() ?? ''} by month.`
        }
        actions={
          <>
            <Segmented<Span>
              label="Span"
              options={[
                { value: 'month', label: 'Month' },
                { value: 'year', label: 'Year' },
              ]}
              value={span}
              onChange={setSpan}
            />
            {span === 'year' ? (
              <Segmented<Figure>
                label="Figure"
                options={FIGURES}
                value={figure}
                onChange={setFigure}
              />
            ) : null}
            <Button
              variant="secondary"
              onClick={() => {
                setEditing('new');
              }}
            >
              Add a line
            </Button>
          </>
        }
      />
      {query.status === 'error' ? <PartialNotice pending="the latest figures" /> : null}
      {grid.sections.length === 0 ? (
        <Text variant="bodySmall" tone="muted">
          No budget lines yet. Add the plan line by line: Salary under Income, Rent under Housing,
          Groceries under whichever card pays for them.
        </Text>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <caption className="sr-only">Budget lines by month</caption>
            <thead>
              <tr className="border-b border-divider text-left">
                <th scope="col" className="py-2 pr-3">
                  <Text as="span" variant="caption" tone="muted">
                    Line
                  </Text>
                </th>
                <th scope="col" className="py-2 pr-3">
                  <Text as="span" variant="caption" tone="muted">
                    Paid from
                  </Text>
                </th>
                {span === 'month' ? (
                  <>
                    <NumberHeader label="Plan" />
                    <NumberHeader label="Actual" />
                    <NumberHeader label="Left / variance" />
                  </>
                ) : (
                  grid.months.map((each) => <NumberHeader key={each} label={formatMonth(each)} />)
                )}
              </tr>
            </thead>
            {grid.sections.map((section) => (
              <tbody key={`${section.flow}:${section.name}`}>
                <tr className="border-b border-divider bg-surface-raised">
                  <th
                    scope="rowgroup"
                    colSpan={span === 'month' ? 2 : 2}
                    className="py-2 pr-3 text-left"
                  >
                    <Text as="span" variant="caption">
                      {section.name.toUpperCase()}
                    </Text>
                  </th>
                  {span === 'month' ? (
                    <>
                      <NumberCell>
                        <Money amount={section.totals[0]?.plan ?? 0} currency={currency} />
                      </NumberCell>
                      <NumberCell>
                        <Money amount={section.totals[0]?.actual ?? 0} currency={currency} />
                      </NumberCell>
                      <NumberCell>
                        <Left
                          value={left(section.totals[0] ?? EMPTY_CELL, section.flow)}
                          currency={currency}
                          flow={section.flow}
                        />
                      </NumberCell>
                    </>
                  ) : (
                    section.totals.map((cell) => (
                      <NumberCell key={cell.month}>
                        <Money amount={value(cell, section.flow)} currency={currency} />
                      </NumberCell>
                    ))
                  )}
                </tr>
                {section.lines.map((row) => (
                  <tr key={row.line.id} className="border-b border-divider">
                    <th scope="row" className="py-2 pr-3 text-left font-normal">
                      <button
                        type="button"
                        className="text-left underline-offset-2 hover:underline"
                        onClick={() => {
                          setEditing(row.line);
                        }}
                      >
                        <Text as="span" variant="bodySmall">
                          {row.line.name}
                        </Text>
                      </button>
                      {row.line.archived ? <Tag tone="muted">Archived</Tag> : null}
                      {row.line.scheduled ? <Tag tone="neutral">Scheduled</Tag> : null}
                    </th>
                    <td className="py-2 pr-3">
                      <Text as="span" variant="bodySmall" tone="muted">
                        {finance.accounts.find((account) => account.id === row.line.accountId)
                          ?.name ?? ''}
                      </Text>
                    </td>
                    {span === 'month' ? (
                      <>
                        <NumberCell>
                          <button
                            type="button"
                            className="underline-offset-2 hover:underline"
                            aria-label={`Change the plan for ${row.line.name} in ${formatMonth(month, 'long')}`}
                            onClick={() => {
                              setOverride({ line: row.line, month });
                            }}
                          >
                            <Money amount={row.cells[0]?.plan ?? 0} currency={currency} />
                          </button>
                        </NumberCell>
                        <NumberCell>
                          <Money amount={row.cells[0]?.actual ?? 0} currency={currency} />
                          {(row.cells[0]?.transactions ?? 0) > 0 ? (
                            <Text as="span" variant="caption" tone="muted">
                              {' '}
                              ({String(row.cells[0]?.transactions ?? 0)})
                            </Text>
                          ) : null}
                        </NumberCell>
                        <NumberCell>
                          <Left
                            value={left(row.cells[0] ?? EMPTY_CELL, section.flow)}
                            currency={currency}
                            flow={section.flow}
                          />
                        </NumberCell>
                      </>
                    ) : (
                      row.cells.map((cell) => (
                        <NumberCell key={cell.month}>
                          <button
                            type="button"
                            className="underline-offset-2 hover:underline"
                            aria-label={`${row.line.name}, ${formatMonth(cell.month, 'long')}`}
                            onClick={() => {
                              if (figure === 'plan')
                                setOverride({ line: row.line, month: cell.month });
                              else onMonth(cell.month);
                            }}
                          >
                            <Money amount={value(cell, section.flow)} currency={currency} />
                          </button>
                        </NumberCell>
                      ))
                    )}
                  </tr>
                ))}
              </tbody>
            ))}
            <tfoot>
              {span === 'month' ? (
                <Totals grid={grid} currency={currency} />
              ) : (
                <>
                  <tr className="border-t border-divider">
                    <th scope="row" colSpan={2} className="py-2 pr-3 text-left">
                      <Text as="span" variant="bodySmall" className="font-medium">
                        Net
                      </Text>
                    </th>
                    {grid.totals.map((totals) => (
                      <NumberCell key={totals.month}>
                        <Money
                          amount={
                            figure === 'plan'
                              ? totals.plan.net
                              : figure === 'actual'
                                ? totals.actual.net
                                : totals.actual.net - totals.plan.net
                          }
                          currency={currency}
                          signed={figure === 'left'}
                        />
                      </NumberCell>
                    ))}
                  </tr>
                  <tr>
                    <th scope="row" colSpan={2} className="py-2 pr-3 text-left">
                      <Text as="span" variant="bodySmall" tone="muted">
                        Cumulative net since {formatMonth(finance.settings.startMonth)}
                      </Text>
                    </th>
                    {grid.totals.map((totals) => (
                      <NumberCell key={totals.month}>
                        <Money
                          amount={
                            figure === 'actual'
                              ? totals.cumulativeNetActual
                              : totals.cumulativeNetPlan
                          }
                          currency={currency}
                        />
                      </NumberCell>
                    ))}
                  </tr>
                </>
              )}
            </tfoot>
          </table>
        </div>
      )}
      <LineDialog
        state={state}
        finance={finance}
        line={editing === 'new' || editing === null ? null : editing}
        open={editing !== null}
        onClose={() => {
          setEditing(null);
        }}
      />
      {override === null ? null : (
        <OverrideDialog
          state={state}
          line={override.line}
          month={override.month}
          currency={currency}
          onClose={() => {
            setOverride(null);
          }}
        />
      )}
    </div>
  );
}

const EMPTY_CELL = { month: '', plan: 0, actual: 0, variance: 0, transactions: 0 };

/** Spending left against the plan, or income surplus/shortfall against it. */
function left(cell: BudgetGrid['sections'][number]['totals'][number], flow: 'income' | 'expense') {
  return flow === 'income' ? cell.variance : -cell.variance;
}

function NumberHeader({ label }: { readonly label: string }): ReactNode {
  return (
    <th scope="col" className="py-2 pl-3 text-right">
      <Text as="span" variant="caption" tone="muted">
        {label}
      </Text>
    </th>
  );
}

function NumberCell({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <td className="py-2 pl-3 text-right">
      <Text as="span" variant="bodySmall">
        {children}
      </Text>
    </td>
  );
}

/** What is left of the plan: for spending, plan minus actual; for income, actual minus plan. */
function Left({
  value,
  currency,
  flow,
}: {
  readonly value: number;
  readonly currency: string;
  readonly flow: 'income' | 'expense';
}): ReactNode {
  if (value < 0) {
    return (
      <span className="flex items-center justify-end gap-1">
        <Money amount={Math.abs(value)} currency={currency} />
        <Tag tone="accent">{flow === 'income' ? 'short' : 'over'}</Tag>
      </span>
    );
  }
  return <Money amount={value} currency={currency} />;
}

function Totals({
  grid,
  currency,
}: {
  readonly grid: BudgetGrid;
  readonly currency: string;
}): ReactNode {
  const totals = grid.totals[0];
  if (totals === undefined) return null;
  const rows: readonly {
    readonly label: string;
    readonly plan: number;
    readonly actual: number;
    readonly remainder: number;
    readonly signed?: boolean;
    readonly hint?: string;
  }[] = [
    {
      label: 'Paid this month',
      plan: totals.plan.paidThisMonth,
      actual: totals.actual.paidThisMonth,
      remainder: totals.plan.paidThisMonth - totals.actual.paidThisMonth,
      hint: 'Direct debits and debit spending',
    },
    {
      label: 'Card spend, paid next month',
      plan: totals.plan.cardSpend,
      actual: totals.actual.cardSpend,
      remainder: totals.plan.cardSpend - totals.actual.cardSpend,
    },
    {
      label: 'Total outgoings',
      plan: totals.plan.outgoings,
      actual: totals.actual.outgoings,
      remainder: totals.plan.outgoings - totals.actual.outgoings,
    },
    {
      label: 'Net',
      plan: totals.plan.net,
      actual: totals.actual.net,
      remainder: totals.actual.net - totals.plan.net,
      signed: true,
      hint: 'Income less outgoings',
    },
    {
      label: `Cumulative net since ${formatMonth(grid.months[0] ?? '')}`,
      plan: totals.cumulativeNetPlan,
      actual: totals.cumulativeNetActual,
      remainder: totals.cumulativeNetActual - totals.cumulativeNetPlan,
      signed: true,
    },
  ];
  return (
    <>
      {totals.unassignedTransactions > 0 ? (
        <tr className="border-t border-divider">
          <th scope="row" colSpan={2} className="py-2 pr-3 text-left">
            <Text as="span" variant="bodySmall">
              Unassigned
            </Text>
            <Text as="span" variant="caption" tone="muted">
              {' '}
              {String(totals.unassignedTransactions)} with no budget line
            </Text>
          </th>
          <NumberCell>
            <Money amount={0} currency={currency} />
          </NumberCell>
          <NumberCell>
            <Money
              amount={totals.unassignedOutflow - totals.unassignedInflow}
              currency={currency}
            />
          </NumberCell>
          <NumberCell>
            <Left
              value={totals.unassignedInflow - totals.unassignedOutflow}
              currency={currency}
              flow="expense"
            />
          </NumberCell>
        </tr>
      ) : null}
      {rows.map((row) => (
        <tr key={row.label} className="border-t border-divider">
          <th scope="row" colSpan={2} className="py-2 pr-3 text-left">
            <Text as="span" variant="bodySmall" className="font-medium">
              {row.label}
            </Text>
            {row.hint === undefined ? null : (
              <Text as="span" variant="caption" tone="muted">
                {' '}
                {row.hint}
              </Text>
            )}
          </th>
          <NumberCell>
            <Money amount={row.plan} currency={currency} />
          </NumberCell>
          <NumberCell>
            <Money amount={row.actual} currency={currency} />
          </NumberCell>
          <NumberCell>
            <Money amount={row.remainder} currency={currency} signed={row.signed ?? false} />
          </NumberCell>
        </tr>
      ))}
    </>
  );
}

/** Changes one month's plan for a line, leaving every other month as it was. */
function OverrideDialog({
  state,
  line,
  month,
  currency,
  onClose,
}: {
  readonly state: FinanceState;
  readonly line: BudgetLine;
  readonly month: string;
  readonly currency: string;
  readonly onClose: () => void;
}): ReactNode {
  const existing = line.overrides[month];
  const [amount, setAmount] = useState(String(existing ?? line.amount));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (event: SyntheticEvent, clear: boolean): Promise<void> => {
    event.preventDefault();
    const overrides: Record<string, number> = Object.fromEntries(
      Object.entries(line.overrides).filter(([key]) => key !== month),
    );
    if (!clear) {
      const parsed = parseAmount(amount);
      if (parsed === null || parsed < 0) {
        setError('The plan for a month is an amount of zero or more.');
        return;
      }
      overrides[month] = parsed;
    }
    setBusy(true);
    const refusal = await state.setLine(line.id, {
      name: line.name,
      section: line.section,
      flow: line.flow,
      accountId: line.accountId,
      amount: line.amount,
      overrides,
      scheduled: line.scheduled,
      dueDay: line.dueDay,
      loanAccount: line.loanAccount,
      archived: line.archived,
    });
    setBusy(false);
    setError(refusal);
    if (refusal === null) onClose();
  };
  return (
    <Dialog open title={`${line.name} in ${formatMonth(month, 'long')}`} onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          void save(event, false);
        }}
      >
        <Text as="p" variant="bodySmall" tone="muted">
          {line.loanAccount === null
            ? `Every other month keeps ${line.amount.toLocaleString()} ${currency}${existing === undefined ? '' : '; this month currently differs'}.`
            : 'This line follows its loan; change the loan instead.'}
        </Text>
        <Field label={`Plan for ${formatMonth(month)}`}>
          {(control) => (
            <Input
              {...control}
              inputMode="decimal"
              disabled={line.loanAccount !== null}
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
              }}
            />
          )}
        </Field>
        <WriteError message={error} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {existing === undefined ? null : (
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={(event) => {
                void save(event, true);
              }}
            >
              Use the usual amount
            </Button>
          )}
          <Button type="submit" disabled={busy || line.loanAccount !== null}>
            Save this month
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
