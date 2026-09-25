import {
  Button,
  Checkbox,
  Dialog,
  Field,
  Input,
  Select,
  Table,
  Tag,
  Text,
  type TableColumn,
} from '@nix/ui';
import {
  finance as financeApi,
  type BudgetLine,
  type Finance,
  type FinanceImport,
  type FinanceTransaction,
  type FinanceTransactions as Transactions,
} from '@nix/api-client';
import { useEffect, useMemo, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { ErrorPanel, LoadingPanel, PartialNotice } from '../../components/states/status-panels';
import { Money, SectionHeading, WriteError, editableTextButton } from './finance-shared';
import { formatDay, formatMonth, monthOf, parseAmount, todayIn } from './money';
import { useFinanceQuery, type FinanceState } from './use-finance';

/** The month's transactions, newest first, with a way to record, change and import them. */
export function FinanceTransactions({
  state,
  finance,
  month,
}: {
  readonly state: FinanceState;
  readonly finance: Finance;
  readonly month: string;
}): ReactNode {
  const currency = finance.settings.currency;
  const [accountId, setAccountId] = useState('');
  const [unassigned, setUnassigned] = useState(false);
  const [editing, setEditing] = useState<FinanceTransaction | null>(null);
  const [importing, setImporting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [assignLineId, setAssignLineId] = useState('');
  const [assigning, setAssigning] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);
  const itemId = finance.itemId;
  // The selection is a bulk-editing tool for the rows on screen; a different filter or month
  // means different rows, so a stale selection would silently reassign transactions the person
  // never looked at. Adjusted during render rather than in an effect - the recommended way to
  // reset state on a prop change - so a background reload of the same filter, which changes
  // none of these three, leaves the selection alone and lets it survive the writes it makes.
  const filterKey = `${accountId}|${String(unassigned)}|${month}`;
  const [selectionFilterKey, setSelectionFilterKey] = useState(filterKey);
  if (selectionFilterKey !== filterKey) {
    setSelectionFilterKey(filterKey);
    setSelected(new Set());
    setAssignLineId('');
    setAssignError(null);
  }
  const endpoint = useMemo(
    () =>
      financeApi.listTransactions(itemId, {
        month,
        ...(accountId === '' ? {} : { accountId }),
        ...(unassigned ? { unassigned: true } : {}),
      }),
    [itemId, month, accountId, unassigned],
  );
  const query = useFinanceQuery<Transactions>(endpoint, state.generation);
  const lines = useMemo(
    () => new Map(finance.lines.map((line) => [line.id, line])),
    [finance.lines],
  );
  const accounts = useMemo(
    () => new Map(finance.accounts.map((account) => [account.id, account])),
    [finance.accounts],
  );
  const closed = finance.closedMonths.includes(month);
  const visibleIds = useMemo(
    () => (query.data === null ? [] : query.data.transactions.map((row) => row.id)),
    [query.data],
  );
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const someVisibleSelected = visibleIds.some((id) => selected.has(id));
  const toggleRow = (id: string, checked: boolean): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const toggleAllVisible = (checked: boolean): void => {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of visibleIds) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };
  // Applied one transaction at a time through the same write the edit dialog uses, so a
  // partial failure fails one row rather than the whole batch. Rows that fail stay selected -
  // and reselected, since a retry after fixing whatever was refused should start from them.
  const applyAssignment = async (): Promise<void> => {
    if (assignLineId === '' || query.data === null) return;
    const targets = query.data.transactions.filter((row) => selected.has(row.id));
    if (targets.length === 0) return;
    setAssigning(true);
    setAssignError(null);
    const failed = new Set<string>();
    // Counts, not just the last reason: several rows can be refused for different reasons in the
    // same batch, and reporting only whichever one happened to run last would misdescribe the
    // rest. Insertion order in this Map is the order each distinct reason was first seen.
    const reasonCounts = new Map<string, number>();
    for (const row of targets) {
      const refusal = await state.setTransaction(row.id, {
        description: row.description,
        date: row.date,
        amount: row.amount,
        accountId: row.accountId,
        lineId: assignLineId,
        cleared: row.cleared,
      });
      if (refusal !== null) {
        failed.add(row.id);
        reasonCounts.set(refusal, (reasonCounts.get(refusal) ?? 0) + 1);
      }
    }
    setAssigning(false);
    setSelected(failed);
    if (failed.size === 0) {
      setAssignLineId('');
    } else {
      const succeeded = targets.length - failed.size;
      const reasons = [...reasonCounts.entries()]
        .map(([reason, count]) => `${reason} (${String(count)})`)
        .join(', ');
      setAssignError(
        `Assigned ${String(succeeded)} of ${String(targets.length)}; ${String(failed.size)} ` +
          `${failed.size === 1 ? 'was' : 'were'} refused: ${reasons}`,
      );
    }
  };
  const columns: readonly TableColumn<FinanceTransaction>[] = [
    {
      key: 'select',
      header: '',
      cell: (row) => (
        <Checkbox
          aria-label={`Select ${row.description}`}
          checked={selected.has(row.id)}
          onChange={(event) => {
            toggleRow(row.id, event.target.checked);
          }}
        />
      ),
    },
    { key: 'date', header: 'Date', cell: (row) => formatDay(row.date) },
    {
      key: 'description',
      header: 'Description',
      rowHeader: true,
      cell: (row) => (
        <button
          type="button"
          className={editableTextButton}
          onClick={() => {
            setEditing(row);
          }}
        >
          {row.description}
        </button>
      ),
    },
    {
      key: 'line',
      header: 'Budget line',
      cell: (row) =>
        row.lineId === null ? (
          <Tag tone="accent">Unassigned</Tag>
        ) : (
          (lines.get(row.lineId)?.name ?? 'Unknown line')
        ),
    },
    {
      key: 'account',
      header: 'Account',
      cell: (row) => accounts.get(row.accountId)?.name ?? 'Unknown account',
    },
    {
      key: 'source',
      header: 'Recorded',
      cell: (row) =>
        row.source === 'scheduled'
          ? 'Posted from plan'
          : row.source === 'import'
            ? 'Imported'
            : 'By hand',
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'end',
      cell: (row) => <Money amount={row.amount} currency={currency} signed />,
    },
  ];
  return (
    <div className="flex flex-col gap-4">
      <SectionHeading
        id="finance-transactions-title"
        title="Transactions"
        detail={`${formatMonth(month, 'long')}${closed ? ', closed' : ''}. Negative amounts left an account; positive ones arrived.`}
        actions={
          <>
            <Button
              onClick={() => {
                setAdding(true);
              }}
            >
              Add transaction
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setImporting(true);
              }}
            >
              Import a statement
            </Button>
          </>
        }
      />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field label="Account">
          {(control) => (
            <Select
              {...control}
              value={accountId}
              onChange={(event) => {
                setAccountId(event.target.value);
              }}
            >
              <option value="">Every account</option>
              {finance.accounts
                .filter((account) => account.type !== 'loan')
                .map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
            </Select>
          )}
        </Field>
        <label className="flex items-center gap-2 pb-2">
          <input
            type="checkbox"
            checked={unassigned}
            onChange={(event) => {
              setUnassigned(event.target.checked);
            }}
          />
          <Text as="span" variant="bodySmall">
            Only those with no budget line
          </Text>
        </label>
      </div>
      {query.data === null ? (
        query.status === 'error' ? (
          <ErrorPanel title="The transactions could not be loaded" detail={query.error ?? ''} />
        ) : (
          <LoadingPanel label="transactions" />
        )
      ) : (
        <>
          {query.status === 'error' ? <PartialNotice pending="the latest transactions" /> : null}
          {query.data.truncated ? (
            <Text variant="bodySmall" tone="muted" role="status">
              Showing the newest {String(query.data.transactions.length)} of{' '}
              {String(query.data.total)}. Narrow by account to see the rest.
            </Text>
          ) : null}
          {query.data.transactions.length === 0 ? null : (
            <div className="flex flex-wrap items-center gap-3 rounded-lg bg-surface-raised p-3">
              <Checkbox
                label={`Select all ${String(visibleIds.length)} visible`}
                checked={allVisibleSelected}
                indeterminate={someVisibleSelected && !allVisibleSelected}
                onChange={(event) => {
                  toggleAllVisible(event.target.checked);
                }}
              />
              {selected.size === 0 ? null : (
                <div className="flex flex-wrap items-center gap-2">
                  <Text as="span" variant="bodySmall">
                    {String(selected.size)} selected
                  </Text>
                  <Select
                    aria-label="Assign to line"
                    value={assignLineId}
                    onChange={(event) => {
                      setAssignLineId(event.target.value);
                    }}
                  >
                    <option value="">Choose a line</option>
                    {linesBySection(finance.lines).map(([section, sectionLines]) => (
                      <optgroup key={section} label={section}>
                        {sectionLines.map((sectionLine) => (
                          <option key={sectionLine.id} value={sectionLine.id}>
                            {sectionLine.name}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </Select>
                  <Button
                    disabled={assignLineId === '' || assigning}
                    onClick={() => {
                      void applyAssignment();
                    }}
                  >
                    Apply
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={assigning}
                    onClick={() => {
                      setSelected(new Set());
                      setAssignError(null);
                    }}
                  >
                    Clear selection
                  </Button>
                </div>
              )}
            </div>
          )}
          <WriteError message={assignError} />
          <Table<FinanceTransaction>
            caption={`Transactions in ${formatMonth(month, 'long')}`}
            columns={columns}
            rows={query.data.transactions}
            rowKey={(row) => row.id}
            emptyMessage="Nothing recorded for this month yet."
          />
        </>
      )}
      <QuickAddDialog
        state={state}
        finance={finance}
        month={month}
        open={adding}
        onClose={() => {
          setAdding(false);
        }}
      />
      {editing === null ? null : (
        <TransactionDialog
          state={state}
          finance={finance}
          transaction={editing}
          onClose={() => {
            setEditing(null);
          }}
        />
      )}
      <ImportDialog
        state={state}
        finance={finance}
        open={importing}
        onClose={() => {
          setImporting(false);
        }}
      />
    </div>
  );
}

function linesBySection(
  lines: readonly BudgetLine[],
): readonly (readonly [string, readonly BudgetLine[]])[] {
  const groups = new Map<string, BudgetLine[]>();
  for (const line of lines) {
    if (line.archived) continue;
    groups.set(line.section, [...(groups.get(line.section) ?? []), line]);
  }
  return [...groups.entries()];
}

/** A quick-add: description, amount, line, account, day. Spending is typed as a positive figure. */
export function QuickAddDialog({
  state,
  finance,
  month,
  open,
  onClose,
}: {
  readonly state: FinanceState;
  readonly finance: Finance;
  readonly month: string;
  readonly open: boolean;
  readonly onClose: () => void;
}): ReactNode {
  return open ? (
    <TransactionDialog
      state={state}
      finance={finance}
      transaction={null}
      month={month}
      onClose={onClose}
    />
  ) : null;
}

/**
 * Records or edits one transaction. Opened from a budget cell, `line` fills in the line, its
 * account and its direction so the person only types the amount.
 */
export function TransactionDialog({
  state,
  finance,
  transaction,
  month,
  line = null,
  onClose,
}: {
  readonly state: FinanceState;
  readonly finance: Finance;
  /** The transaction to edit, or null to record one. */
  readonly transaction: FinanceTransaction | null;
  readonly month?: string;
  /** The budget line a new transaction is for, when it is opened from that line. */
  readonly line?: BudgetLine | null;
  readonly onClose: () => void;
}): ReactNode {
  const currency = finance.settings.currency;
  const today = todayIn(finance.settings.timezone);
  const defaultDay = month === undefined || monthOf(today) === month ? today : `${month}-01`;
  const [description, setDescription] = useState(transaction?.description ?? '');
  const [amount, setAmount] = useState(
    transaction === null ? '' : String(Math.abs(transaction.amount)),
  );
  const [direction, setDirection] = useState<'out' | 'in'>(
    transaction !== null
      ? transaction.amount > 0
        ? 'in'
        : 'out'
      : line?.flow === 'income'
        ? 'in'
        : 'out',
  );
  const [lineId, setLineId] = useState(transaction?.lineId ?? line?.id ?? '');
  const [accountId, setAccountId] = useState(transaction?.accountId ?? line?.accountId ?? '');
  const [date, setDate] = useState(transaction?.date ?? defaultDay);
  // Captured once, from the values the form opened with, so a backdrop tap or Escape after the
  // person has actually changed something is refused rather than silently discarding it.
  const [initial] = useState({ description, amount, direction, lineId, accountId, date });
  const dirty =
    description !== initial.description ||
    amount !== initial.amount ||
    direction !== initial.direction ||
    lineId !== initial.lineId ||
    accountId !== initial.accountId ||
    date !== initial.date;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const amountField = useRef<HTMLInputElement | null>(null);
  // The confirm replaces the Delete button, so focus is placed on the safe answer when it appears
  // and handed back to Delete when the person keeps the transaction.
  const deleteButton = useRef<HTMLButtonElement | null>(null);
  const keepButton = useRef<HTMLButtonElement | null>(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (confirmingDelete) keepButton.current?.focus();
    else if (wasConfirming.current) deleteButton.current?.focus();
    wasConfirming.current = confirmingDelete;
  }, [confirmingDelete]);
  const spendable = finance.accounts.filter(
    (account) => account.type !== 'loan' && !account.archived,
  );
  // Choosing a line answers the account and the direction; either can still be changed after.
  const chooseLine = (id: string): void => {
    setLineId(id);
    const line = finance.lines.find((candidate) => candidate.id === id);
    if (line === undefined) return;
    if (transaction === null) setAccountId(line.accountId);
    setDirection(line.flow === 'income' ? 'in' : 'out');
  };

  // `keepOpen` is the "Save and add another" path: the date, account and line usually carry
  // over to the next entry, so only what changes row to row - the amount and description - is
  // cleared, and the dialog stays open for the next one instead of closing.
  const record = async (keepOpen: boolean): Promise<void> => {
    const magnitude = parseAmount(amount);
    if (magnitude === null || magnitude === 0) {
      setError('Enter the amount that moved.');
      return;
    }
    const input = {
      description: description.trim(),
      date,
      amount: direction === 'out' ? -Math.abs(magnitude) : Math.abs(magnitude),
      accountId: accountId === '' ? (spendable[0]?.id ?? '') : accountId,
      lineId: lineId === '' ? null : lineId,
      cleared: transaction?.cleared ?? false,
    };
    setBusy(true);
    const refusal =
      transaction === null
        ? await state.createTransaction(input)
        : await state.setTransaction(transaction.id, input);
    setBusy(false);
    setError(refusal);
    if (refusal === null) {
      if (keepOpen) {
        setDescription('');
        setAmount('');
        amountField.current?.focus();
      } else {
        onClose();
      }
    }
  };

  const submit = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault();
    await record(false);
  };

  const remove = async (): Promise<void> => {
    if (transaction === null) return;
    setBusy(true);
    const refusal = await state.deleteTransaction(transaction.id);
    setBusy(false);
    setError(refusal);
    if (refusal === null) onClose();
  };

  return (
    <Dialog
      open
      title={transaction === null ? 'Add a transaction' : `Edit ${transaction.description}`}
      onClose={onClose}
      initialFocus={amountField}
      dirty={dirty}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <Field label="Amount" hint={`In ${currency}. Refunds go in as money in.`}>
          {(control) => (
            <div className="flex gap-2">
              <Input
                {...control}
                ref={amountField}
                inputMode="decimal"
                placeholder="12.40"
                value={amount}
                onChange={(event) => {
                  setAmount(event.target.value);
                }}
              />
              <Select
                aria-label="Direction"
                value={direction}
                onChange={(event) => {
                  setDirection(event.target.value === 'in' ? 'in' : 'out');
                }}
              >
                <option value="out">Money out</option>
                <option value="in">Money in</option>
              </Select>
            </div>
          )}
        </Field>
        <Field label="Description" hint="The payee, or what it was for.">
          {(control) => (
            <Input
              {...control}
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
              }}
            />
          )}
        </Field>
        <Field
          label="Budget line"
          hint="Leave unassigned to decide later; it still counts as spending."
        >
          {(control) => (
            <Select
              {...control}
              value={lineId}
              onChange={(event) => {
                chooseLine(event.target.value);
              }}
            >
              <option value="">Unassigned</option>
              {linesBySection(finance.lines).map(([section, lines]) => (
                <optgroup key={section} label={section}>
                  {lines.map((line) => (
                    <option key={line.id} value={line.id}>
                      {line.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Account">
          {(control) => (
            <Select
              {...control}
              value={accountId === '' ? (spendable[0]?.id ?? '') : accountId}
              onChange={(event) => {
                setAccountId(event.target.value);
              }}
            >
              {spendable.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Date">
          {(control) => (
            <Input
              {...control}
              type="date"
              value={date}
              onChange={(event) => {
                setDate(event.target.value);
              }}
            />
          )}
        </Field>
        <WriteError message={error} />
        <div className="flex flex-wrap items-center justify-end gap-2">
          {transaction === null ? null : confirmingDelete ? (
            <span className="mr-auto flex flex-wrap items-center gap-2">
              <Text as="span" variant="bodySmall">
                Delete this transaction?
              </Text>
              <Button
                ref={keepButton}
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setConfirmingDelete(false);
                }}
              >
                Keep it
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  void remove();
                }}
              >
                Yes, delete
              </Button>
            </span>
          ) : (
            <Button
              ref={deleteButton}
              type="button"
              variant="ghost"
              className="mr-auto"
              disabled={busy}
              onClick={() => {
                setConfirmingDelete(true);
              }}
            >
              Delete
            </Button>
          )}
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {transaction === null ? (
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                void record(true);
              }}
            >
              Save and add another
            </Button>
          ) : null}
          <Button type="submit" disabled={busy}>
            {transaction === null ? 'Record' : 'Save'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** A bank CSV: previewed first, so what a commit would do is seen before it does it. */
interface ImportDialogProps {
  readonly state: FinanceState;
  readonly finance: Finance;
  readonly open: boolean;
  readonly onClose: () => void;
}

function ImportDialog(props: ImportDialogProps): ReactNode {
  return props.open ? <ImportForm {...props} /> : null;
}

function ImportForm({ state, finance, onClose }: ImportDialogProps): ReactNode {
  const currency = finance.settings.currency;
  const cashAccounts = finance.accounts.filter(
    (account) => account.type !== 'loan' && !account.archived,
  );
  const [accountId, setAccountId] = useState(cashAccounts[0]?.id ?? '');
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<FinanceImport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (commit: boolean): Promise<void> => {
    if (accountId === '' || csv.trim() === '') {
      setError('Choose an account and paste or choose a CSV export.');
      return;
    }
    setBusy(true);
    const outcome = await state.importStatement({ accountId, csv, commit });
    setBusy(false);
    if (typeof outcome === 'string') {
      setError(outcome);
      return;
    }
    setError(null);
    setPreview(outcome);
    if (commit) onClose();
  };
  const readFile = (file: File | undefined): void => {
    if (file === undefined) return;
    void file.text().then((text) => {
      setCsv(text);
      setPreview(null);
    });
  };
  return (
    <Dialog open title="Import a bank statement" onClose={onClose} presentation="workspace">
      <div className="flex flex-col gap-4">
        <Text as="p" variant="bodySmall" tone="muted">
          A CSV as your bank exports it, with a header row naming a date, an amount (or money in and
          money out) and a description. Rows already recorded are skipped, and a row that matches a
          transaction you typed is linked to it rather than added again.
        </Text>
        <Field label="Into account">
          {(control) => (
            <Select
              {...control}
              value={accountId}
              onChange={(event) => {
                setAccountId(event.target.value);
              }}
            >
              {cashAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="CSV file">
          {(control) => (
            <Input
              {...control}
              type="file"
              accept=".csv,text/csv,text/plain"
              onChange={(event) => {
                readFile(event.target.files?.[0]);
              }}
            />
          )}
        </Field>
        <Field label="Or paste the CSV">
          {(control) => (
            <textarea
              {...control}
              rows={6}
              className="w-full rounded-lg border border-divider bg-surface p-2 font-mono"
              value={csv}
              onChange={(event) => {
                setCsv(event.target.value);
                setPreview(null);
              }}
            />
          )}
        </Field>
        {preview === null ? null : (
          <div className="flex flex-col gap-2" role="status">
            <Text as="p" variant="bodySmall">
              {String(preview.rows)} rows: {String(preview.created)} new, {String(preview.matched)}{' '}
              matching something already typed, {String(preview.duplicates)} already imported,{' '}
              {String(preview.unreadable)} unreadable.
            </Text>
            <div className="max-h-64 overflow-auto">
              <Table<FinanceImport['preview'][number]>
                caption="Statement rows"
                columns={[
                  { key: 'row', header: 'Row', cell: (row) => String(row.row) },
                  {
                    key: 'date',
                    header: 'Date',
                    cell: (row) => (row.date === null ? '' : formatDay(row.date)),
                  },
                  {
                    key: 'description',
                    header: 'Description',
                    rowHeader: true,
                    cell: (row) => row.description,
                  },
                  {
                    key: 'amount',
                    header: 'Amount',
                    align: 'end',
                    cell: (row) =>
                      row.amount === null ? (
                        ''
                      ) : (
                        <Money amount={row.amount} currency={currency} signed />
                      ),
                  },
                  {
                    key: 'status',
                    header: 'Outcome',
                    cell: (row) =>
                      row.status === 'new'
                        ? row.suggestedLineId === null
                          ? 'New, unassigned'
                          : `New, ${finance.lines.find((line) => line.id === row.suggestedLineId)?.name ?? 'assigned'}`
                        : row.status === 'matched'
                          ? 'Matches a typed transaction'
                          : row.status === 'duplicate'
                            ? 'Already imported'
                            : (row.problem ?? 'Unreadable'),
                  },
                ]}
                rows={preview.preview}
                rowKey={(row) => String(row.row)}
                emptyMessage="No rows were read."
              />
            </div>
          </div>
        )}
        <WriteError message={error} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => {
              void run(false);
            }}
          >
            Preview
          </Button>
          <Button
            type="button"
            disabled={busy || preview === null || preview.created + preview.matched === 0}
            onClick={() => {
              void run(true);
            }}
          >
            Import {preview === null ? '' : `${String(preview.created)} new`}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
