import {
  Button,
  Checkbox,
  Dialog,
  Field,
  Input,
  Select,
  Table,
  Segmented,
  Tag,
  Text,
  Textarea,
  cn,
  focusRing,
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
import { useOptionalApiClient } from '../../api/api-client-provider';
import { ErrorPanel, LoadingPanel, PartialNotice } from '../../components/states/status-panels';
import { Money, SectionHeading, WriteError, editableTextButton } from './finance-shared';
import { formatDay, formatMonth, monthOf, parseAmount, todayIn, shiftMonth } from './money';
import { useFinanceQuery, type FinanceState } from './use-finance';

/** The month's transactions, newest first, with a way to record, change and import them. */
export function FinanceTransactions({
  state,
  finance,
  month,
  initialLineId = '',
  initialAccountId = '',
  initialUnassigned = false,
}: {
  readonly state: FinanceState;
  readonly finance: Finance;
  readonly month: string;
  readonly initialLineId?: string | undefined;
  readonly initialAccountId?: string | undefined;
  readonly initialUnassigned?: boolean | undefined;
}): ReactNode {
  const currency = finance.settings.currency;
  const client = useOptionalApiClient();
  const reads = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    reads.current = controller;
    return () => {
      controller.abort();
    };
  }, [client]);
  const [changes, setChanges] = useState<readonly SessionChange[]>([]);
  const [restoring, setRestoring] = useState<SessionChange | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);
  const [accountId, setAccountId] = useState(initialAccountId);
  const [lineFilter, setLineFilter] = useState(initialLineId);
  const [range, setRange] = useState<'month' | 'all' | 'custom'>('month');
  const [from, setFrom] = useState(`${month}-01`);
  const [to, setTo] = useState(monthEnd(month));
  const [search, setSearch] = useState('');
  const [source, setSource] = useState('');
  const [minAmount, setMinAmount] = useState('');
  const [maxAmount, setMaxAmount] = useState('');
  const [filters, setFilters] = useState({
    search: '',
    source: '',
    from: '',
    to: '',
    minAmount: '',
    maxAmount: '',
  });
  const [filterError, setFilterError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [previewAssignment, setPreviewAssignment] = useState(false);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [unassigned, setUnassigned] = useState(initialUnassigned);
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
  const filterKey = `${accountId}|${lineFilter}|${String(unassigned)}|${month}|${range}|${JSON.stringify(filters)}|${String(offset)}`;
  const [previousMonth, setPreviousMonth] = useState(month);
  if (previousMonth !== month) {
    setPreviousMonth(month);
    setOffset(0);
  }
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
        ...(range === 'month' ? { month } : {}),
        ...(range === 'custom' ? { from: filters.from, to: filters.to } : {}),
        ...(filters.search === '' ? {} : { search: filters.search }),
        ...(filters.source === ''
          ? {}
          : { source: filters.source as FinanceTransaction['source'] }),
        ...(filters.minAmount === ''
          ? {}
          : { minAmount: Number(filters.minAmount.replaceAll(',', '')) }),
        ...(filters.maxAmount === ''
          ? {}
          : { maxAmount: Number(filters.maxAmount.replaceAll(',', '')) }),
        ...(lineFilter === '' ? {} : { lineId: lineFilter }),
        offset,
        limit: 50,
        ...(accountId === '' ? {} : { accountId }),
        ...(unassigned ? { unassigned: true } : {}),
      }),
    [itemId, month, accountId, lineFilter, unassigned, range, filters, offset],
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
  const applyFilters = (): void => {
    const min = minAmount === '' ? null : parseAmount(minAmount);
    const max = maxAmount === '' ? null : parseAmount(maxAmount);
    if (
      (minAmount !== '' && (min === null || min < 0)) ||
      (maxAmount !== '' && (max === null || max < 0)) ||
      (min !== null && max !== null && min > max)
    ) {
      setFilterError('Enter valid amounts of zero or more, with the smaller amount first.');
      return;
    }
    if (range === 'custom' && (from === '' || to === '' || from > to)) {
      setFilterError('Choose a start and end date, with the earlier date first.');
      return;
    }
    setFilterError(null);
    setOffset(0);
    setFilters({
      search: search.trim(),
      source,
      from,
      to,
      minAmount: min === null ? '' : String(min),
      maxAmount: max === null ? '' : String(max),
    });
  };
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
    setPreviewAssignment(false);
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
      if (refusal === null)
        setChanges((current) =>
          [{ before: row, after: { ...row, lineId: assignLineId } }, ...current].slice(0, 25),
        );
      if (refusal !== null) {
        failed.add(row.id);
        reasonCounts.set(refusal, (reasonCounts.get(refusal) ?? 0) + 1);
      }
    }
    setAssigning(false);
    setSelected(failed);
    if (failed.size === 0) {
      setAnnouncement(
        `Updated the category for ${String(targets.length)} transactions. Totals are refreshing.`,
      );
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
      header: 'Select',
      cell: (row) => (
        <Checkbox
          aria-label={`Select ${row.description}`}
          checked={selected.has(row.id)}
          disabled={query.status !== 'ready' || assigning}
          onChange={(event) => {
            toggleRow(row.id, event.target.checked);
          }}
        />
      ),
    },
    {
      key: 'date',
      header: 'Date',
      cell: (row) => `${formatDay(row.date)} ${row.date.slice(0, 4)}`,
    },
    {
      key: 'description',
      header: 'Description',
      rowHeader: true,
      cell: (row) => (
        <button
          type="button"
          className={editableTextButton}
          disabled={query.status !== 'ready' || assigning}
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
      header: 'Category',
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
    <div className="@container flex min-w-0 flex-col gap-4">
      <SectionHeading
        id="finance-transactions-title"
        title="Transaction history"
        detail="Find past payments and correct them. Select a description to edit; money out is negative."
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
      <form
        className="flex flex-col gap-3 rounded-lg border border-divider p-4"
        onSubmit={(event) => {
          event.preventDefault();
          applyFilters();
        }}
      >
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Search transactions" className="min-w-0 flex-1 basis-48">
            {(control) => (
              <Input
                {...control}
                type="search"
                placeholder="Payee or description"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                }}
              />
            )}
          </Field>
          <Segmented<'month' | 'all' | 'custom'>
            className="min-w-0 flex-wrap"
            label="History period"
            options={[
              { value: 'month', label: 'Selected month' },
              { value: 'all', label: 'All history' },
              { value: 'custom', label: 'Date range' },
            ]}
            value={range}
            onChange={(value) => {
              setRange(value);
              setOffset(0);
              if (value === 'custom') setFilters((current) => ({ ...current, from, to }));
            }}
          />
          <Button type="submit">Search</Button>
          {filters.search !== '' ||
          filters.source !== '' ||
          accountId !== '' ||
          lineFilter !== '' ||
          unassigned ||
          filters.minAmount !== '' ||
          filters.maxAmount !== '' ? (
            <Button
              variant="ghost"
              onClick={() => {
                setSearch('');
                setSource('');
                setMinAmount('');
                setMaxAmount('');
                setAccountId('');
                setLineFilter('');
                setUnassigned(false);
                setOffset(0);
                setFilterError(null);
                setFilters({ search: '', source: '', from, to, minAmount: '', maxAmount: '' });
              }}
            >
              Clear filters
            </Button>
          ) : null}
        </div>
        {range === 'custom' ? (
          <div className="grid min-w-0 grid-cols-1 gap-3 @sm:grid-cols-2">
            <Field label="From date" className="min-w-0">
              {(control) => (
                <Input
                  {...control}
                  type="date"
                  value={from}
                  onChange={(event) => {
                    setFrom(event.target.value);
                  }}
                />
              )}
            </Field>
            <Field label="To date" className="min-w-0">
              {(control) => (
                <Input
                  {...control}
                  type="date"
                  value={to}
                  onChange={(event) => {
                    setTo(event.target.value);
                  }}
                />
              )}
            </Field>
          </div>
        ) : null}
        <details>
          <summary className="cursor-pointer text-muted any-pointer-coarse:min-h-(--control-lg)">
            Filter by account, category or amount
          </summary>
          <div className="mt-3 grid min-w-0 grid-cols-1 gap-3 @lg:grid-cols-2">
            <Field label="Account">
              {(control) => (
                <Select
                  {...control}
                  value={accountId}
                  onChange={(event) => {
                    setAccountId(event.target.value);
                    setOffset(0);
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
            <Field label="Category">
              {(control) => (
                <Select
                  {...control}
                  value={unassigned ? 'unassigned' : lineFilter}
                  onChange={(event) => {
                    setUnassigned(event.target.value === 'unassigned');
                    setLineFilter(event.target.value === 'unassigned' ? '' : event.target.value);
                    setOffset(0);
                  }}
                >
                  <option value="">Every category</option>
                  <option value="unassigned">Unassigned</option>
                  {finance.lines.map((line) => (
                    <option key={line.id} value={line.id}>
                      {line.name}
                      {line.archived ? ' (archived)' : ''}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Source">
              {(control) => (
                <Select
                  {...control}
                  value={source}
                  onChange={(event) => {
                    setSource(event.target.value);
                  }}
                >
                  <option value="">Every source</option>
                  <option value="manual">By hand</option>
                  <option value="import">Imported statement</option>
                  <option value="scheduled">Posted from plan</option>
                </Select>
              )}
            </Field>
            <div className="grid min-w-0 grid-cols-1 gap-3 @sm:grid-cols-2">
              <Field label="Amount from" hint={currency} className="min-w-0">
                {(control) => (
                  <Input
                    {...control}
                    inputMode="decimal"
                    value={minAmount}
                    onChange={(event) => {
                      setMinAmount(event.target.value);
                    }}
                  />
                )}
              </Field>
              <Field label="Amount to" hint="Money in or out" className="min-w-0">
                {(control) => (
                  <Input
                    {...control}
                    inputMode="decimal"
                    value={maxAmount}
                    onChange={(event) => {
                      setMaxAmount(event.target.value);
                    }}
                  />
                )}
              </Field>
            </div>
          </div>
          <Button type="submit" variant="secondary" className="mt-3">
            Apply filters
          </Button>
        </details>
        <WriteError message={filterError} />
      </form>
      {query.data === null ? (
        query.status === 'error' ? (
          <ErrorPanel title="The transactions could not be loaded" detail={query.error ?? ''} />
        ) : (
          <LoadingPanel label="transactions" />
        )
      ) : (
        <>
          {query.status === 'error' ? <PartialNotice pending="the latest transactions" /> : null}
          {query.data.offset === undefined ? (
            <Text variant="bodySmall" tone="muted" role="status">
              Update the server to use the new history filters and paging. The records below may not
              match all selected filters.
            </Text>
          ) : null}
          {query.data.truncated && query.data.nextOffset === undefined ? (
            <Text variant="bodySmall" tone="muted" role="status">
              This server returned a partial history. Narrow the dates or account to see more
              records.
            </Text>
          ) : null}
          {query.status === 'loading' ? (
            <Text variant="bodySmall" tone="muted" role="status">
              Updating results. Previous results remain below.
            </Text>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-divider pb-3">
            <Text variant="bodySmall">{String(query.data.total)} matching transactions</Text>
            <dl className="flex flex-wrap gap-6">
              {(['inflow', 'outflow', 'net'] as const).map((key) => (
                <div key={key}>
                  <Text as="dt" variant="caption" tone="muted">
                    {key === 'inflow'
                      ? 'Money in'
                      : key === 'outflow'
                        ? 'Money out'
                        : 'Net movement'}
                  </Text>
                  <Text as="dd" variant="body" className="font-medium">
                    {query.data?.[key] === undefined ? (
                      'Unavailable from this server'
                    ) : (
                      <Money amount={query.data[key]} currency={currency} signed={key === 'net'} />
                    )}
                  </Text>
                </div>
              ))}
            </dl>
          </div>
          {query.data.transactions.length === 0 ? null : (
            <div className="flex flex-wrap items-center gap-3 rounded-lg bg-surface-raised p-3">
              <Checkbox
                label={`Select all ${String(visibleIds.length)} visible`}
                checked={allVisibleSelected}
                disabled={query.status !== 'ready' || assigning}
                indeterminate={someVisibleSelected && !allVisibleSelected}
                onChange={(event) => {
                  toggleAllVisible(event.target.checked);
                }}
              />
              {selected.size === 0 ? null : (
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Text as="span" variant="bodySmall">
                    {String(selected.size)} selected
                  </Text>
                  <Select
                    className="min-w-0 flex-1 basis-48"
                    aria-label="Assign to line"
                    value={assignLineId}
                    disabled={assigning}
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
                    disabled={assignLineId === '' || assigning || query.status !== 'ready'}
                    onClick={() => {
                      setPreviewAssignment(true);
                    }}
                  >
                    Preview change
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
          <div
            role="region"
            aria-label="Transaction history"
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Justification: keyboard users need to reach horizontally clipped transaction columns.
            tabIndex={0}
            className={cn('min-w-0 overflow-x-auto', focusRing)}
          >
            <Table<FinanceTransaction>
              caption="Matching transactions, newest first"
              columns={columns}
              rows={query.data.transactions}
              rowKey={(row) => row.id}
              rowContextMenuLabel={(row) => `Actions for ${row.description}`}
              rowContextMenu={(row) => [
                {
                  label: 'Edit transaction',
                  disabled: query.status !== 'ready' || assigning,
                  onSelect: () => {
                    setEditing(row);
                  },
                },
              ]}
              emptyMessage="No matching transactions. Try another date range or clear your filters."
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Text variant="bodySmall" tone="muted">
              Showing {query.data.total === 0 ? '0' : String((query.data.offset ?? 0) + 1)}–
              {String((query.data.offset ?? 0) + query.data.transactions.length)} of{' '}
              {String(query.data.total)}
            </Text>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                disabled={offset === 0 || query.status !== 'ready'}
                onClick={() => {
                  setOffset(Math.max(0, offset - 50));
                }}
              >
                Previous 50
              </Button>
              <Button
                variant="secondary"
                disabled={query.data.nextOffset == null || query.status !== 'ready'}
                onClick={() => {
                  setOffset(query.data?.nextOffset ?? offset);
                }}
              >
                Next 50
              </Button>
            </div>
          </div>
        </>
      )}
      {changes.length === 0 ? null : (
        <details className="rounded-lg border border-divider p-3">
          <summary className="cursor-pointer text-muted any-pointer-coarse:min-h-(--control-lg)">
            Changes in this visit ({String(changes.length)})
          </summary>
          <Text variant="caption" tone="muted" className="mt-2">
            Recent edits made in this history screen. This list clears when you leave or reload;
            saved records remain in your finances.
          </Text>
          <ul className="mt-3 flex flex-col gap-3">
            {changes.map((change, index) => (
              <li
                key={`${change.before.id}-${String(index)}`}
                className="flex flex-wrap items-center justify-between gap-3"
              >
                <Text variant="bodySmall">
                  {change.before.description}:{' '}
                  <Money amount={change.before.amount} currency={currency} signed /> to{' '}
                  <Money amount={change.after.amount} currency={currency} signed />;{' '}
                  {lines.get(change.before.lineId ?? '')?.name ?? 'Unassigned'} to{' '}
                  {lines.get(change.after.lineId ?? '')?.name ?? 'Unassigned'}
                </Text>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setUndoError(null);
                    setRestoring(change);
                  }}
                >
                  Review undo
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}
      <WriteError message={undoError} />
      {restoring === null ? null : (
        <TransactionDialog
          state={state}
          finance={finance}
          transaction={restoring.before}
          storedTransaction={restoring.after}
          onClose={() => {
            setRestoring(null);
          }}
          beforeSave={async () => {
            if (client === null) return 'Reconnect to the server before restoring this edit.';
            try {
              const latest = await client.query(
                financeApi.listTransactions(finance.itemId, { transactionId: restoring.after.id }),
                { forceRefresh: true, signal: reads.current?.signal },
              );
              const row = latest.transactions.find(
                (candidate) => candidate.id === restoring.after.id,
              );
              return row === undefined || !sameEditableTransaction(row, restoring.after)
                ? 'This transaction has changed since that edit. Open its current record and review the changes before correcting it.'
                : null;
            } catch {
              return 'The current transaction could not be checked. Try again before restoring.';
            }
          }}
          onSaved={() => {
            setChanges((current) => current.filter((candidate) => candidate !== restoring));
            setAnnouncement('Restored the previous values. Totals are refreshing.');
          }}
        />
      )}
      {announcement === null ? null : (
        <Text variant="bodySmall" role="status">
          {announcement}
        </Text>
      )}
      {previewAssignment ? (
        <Dialog
          open
          title="Review category change"
          onClose={() => {
            setPreviewAssignment(false);
          }}
        >
          <div className="flex flex-col gap-4">
            <Text variant="body">
              Move {String(selected.size)} transactions to {lines.get(assignLineId)?.name}. Amounts
              and accounts stay the same; category totals will update.
            </Text>
            <ul className="flex flex-col gap-2">
              {query.data?.transactions
                .filter((row) => selected.has(row.id))
                .map((row) => (
                  <li key={row.id}>
                    <Text variant="bodySmall">
                      {row.description}:{' '}
                      {row.lineId === null ? 'Unassigned' : lines.get(row.lineId)?.name} to{' '}
                      {lines.get(assignLineId)?.name}
                      {finance.closedMonths.includes(monthOf(row.date)) ? ' (closed month)' : ''}
                    </Text>
                  </li>
                ))}
            </ul>
            {query.data?.transactions.some(
              (row) => selected.has(row.id) && finance.closedMonths.includes(monthOf(row.date)),
            ) ? (
              <Text variant="bodySmall" role="alert">
                Some selected transactions belong to closed months. Correct these individually first
                so you can reopen and close each month safely.
              </Text>
            ) : (
              <Button
                onClick={() => {
                  void applyAssignment();
                }}
              >
                Apply category change
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={() => {
                setPreviewAssignment(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </Dialog>
      ) : null}
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
          onSaved={(before, after) => {
            setChanges((current) => [{ before, after }, ...current].slice(0, 25));
            setAnnouncement('Saved transaction changes. Totals are refreshing.');
          }}
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

interface SessionChange {
  readonly before: FinanceTransaction;
  readonly after: FinanceTransaction;
}

function sameEditableTransaction(left: FinanceTransaction, right: FinanceTransaction): boolean {
  return (
    left.description === right.description &&
    left.amount === right.amount &&
    left.date === right.date &&
    left.accountId === right.accountId &&
    left.lineId === right.lineId &&
    left.cleared === right.cleared
  );
}

function monthEnd(month: string): string {
  const next = new Date(`${shiftMonth(month, 1)}-01T00:00:00Z`);
  next.setUTCDate(0);
  return next.toISOString().slice(0, 10);
}

function linesBySection(
  lines: readonly BudgetLine[],
  retainedId?: string,
): readonly (readonly [string, readonly BudgetLine[]])[] {
  const groups = new Map<string, BudgetLine[]>();
  for (const line of lines) {
    if (line.archived && line.id !== retainedId) continue;
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
  onSaved,
  beforeSave,
  storedTransaction,
}: {
  readonly state: FinanceState;
  readonly finance: Finance;
  /** The transaction to edit, or null to record one. */
  readonly transaction: FinanceTransaction | null;
  readonly month?: string;
  /** The budget line a new transaction is for, when it is opened from that line. */
  readonly line?: BudgetLine | null;
  readonly onSaved?: (before: FinanceTransaction, after: FinanceTransaction) => void;
  readonly beforeSave?: () => Promise<string | null>;
  readonly storedTransaction?: FinanceTransaction;
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
  const [reopened, setReopened] = useState<readonly string[]>([]);
  const [closeAfter, setCloseAfter] = useState(true);
  const [closePending, setClosePending] = useState(false);
  const closedForEdit = [
    ...new Set([
      monthOf(date),
      ...(transaction === null ? [] : [monthOf(storedTransaction?.date ?? transaction.date)]),
    ]),
  ].filter(
    (candidate) => finance.closedMonths.includes(candidate) && !reopened.includes(candidate),
  );
  const reopen = async (): Promise<void> => {
    setBusy(true);
    for (const candidate of closedForEdit) {
      const refusal = await state.setMonth(candidate, false);
      if (refusal !== null) {
        setError(refusal);
        setBusy(false);
        return;
      }
      setReopened((current) => [...current, candidate]);
    }
    setError(null);
    setBusy(false);
  };
  const finishCorrection = async (): Promise<boolean> => {
    if (!closeAfter) return true;
    for (const candidate of reopened) {
      const refusal = await state.setMonth(candidate, true);
      if (refusal !== null) {
        setClosePending(true);
        setError(
          `The change was saved, but ${formatMonth(candidate)} could not be closed: ${refusal}`,
        );
        return false;
      }
    }
    setClosePending(false);
    return true;
  };
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
    (account) =>
      account.type !== 'loan' && (!account.archived || account.id === transaction?.accountId),
  );
  // Choosing a line answers the account and the direction; either can still be changed after.
  const chooseLine = (id: string): void => {
    setLineId(id);
    const line = finance.lines.find((candidate) => candidate.id === id);
    if (line === undefined) return;
    if (transaction === null) {
      setAccountId(line.accountId);
      setDirection(line.flow === 'income' ? 'in' : 'out');
    }
  };

  // `keepOpen` is the "Save and add another" path: the date, account and line usually carry
  // over to the next entry, so only what changes row to row - the amount and description - is
  // cleared, and the dialog stays open for the next one instead of closing.
  const record = async (keepOpen: boolean): Promise<void> => {
    if (closedForEdit.length > 0) {
      setError('Reopen the closed month before saving this correction.');
      return;
    }
    if (closePending) {
      setBusy(true);
      if (await finishCorrection()) onClose();
      setBusy(false);
      return;
    }
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
    if (beforeSave !== undefined) {
      const problem = await beforeSave();
      if (problem !== null) {
        setBusy(false);
        setError(problem);
        return;
      }
    }
    const refusal =
      transaction === null
        ? await state.createTransaction(input)
        : await state.setTransaction(transaction.id, input);
    setError(refusal);
    if (refusal === null) {
      if (transaction !== null) onSaved?.(transaction, { ...transaction, ...input });
      if (!(await finishCorrection())) {
        setBusy(false);
        return;
      }
      if (keepOpen) {
        setDescription('');
        setAmount('');
        amountField.current?.focus();
      } else {
        onClose();
      }
    }
    setBusy(false);
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
    if (refusal === null && (await finishCorrection())) onClose();
  };

  return (
    <Dialog
      open
      title={
        transaction === null
          ? 'Add a transaction'
          : beforeSave === undefined
            ? `Edit ${transaction.description}`
            : `Review undo for ${transaction.description}`
      }
      onClose={() => {
        if (!busy) onClose();
      }}
      closeLabel={busy ? 'Saving transaction' : 'Close'}
      initialFocus={amountField}
      dirty={dirty || reopened.length > 0}
      presentation={transaction === null ? 'standard' : 'workspace'}
    >
      <form
        className="@container flex min-w-0 flex-col gap-4"
        aria-busy={busy}
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        {beforeSave === undefined ? null : (
          <Text variant="bodySmall">
            Review the previous values below. Restoring checks that this transaction still matches
            your saved edit.
          </Text>
        )}
        {closedForEdit.length > 0 ? (
          <div className="flex flex-col gap-3 rounded-lg border border-divider bg-surface-raised p-3">
            <Text variant="bodySmall">
              {closedForEdit.map((candidate) => formatMonth(candidate, 'long')).join(' and ')} is
              closed. Reopening allows corrections that recalculate account balances, budget totals
              and later forecasts.
            </Text>
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                void reopen();
              }}
            >
              Reopen to correct
            </Button>
          </div>
        ) : null}
        {reopened.length > 0 ? (
          <div className="flex flex-col gap-2">
            <Checkbox
              label="Close reopened months after saving"
              checked={closeAfter}
              disabled={busy}
              onChange={(event) => {
                setCloseAfter(event.target.checked);
              }}
            />
            <Text variant="caption" tone="muted">
              These months stay open if you leave without saving:{' '}
              {reopened.map((candidate) => formatMonth(candidate)).join(', ')}.
            </Text>
          </div>
        ) : null}
        <fieldset disabled={busy || closePending} className="flex flex-col gap-4">
          <Field label="Amount" hint={`In ${currency}. Refunds go in as money in.`}>
            {(control) => (
              <div className="grid min-w-0 grid-cols-1 gap-2 @sm:grid-cols-2">
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
                {linesBySection(finance.lines, lineId).map(([section, lines]) => (
                  <optgroup key={section} label={section}>
                    {lines.map((line) => (
                      <option key={line.id} value={line.id}>
                        {line.name}
                        {line.archived ? ' (archived)' : ''}
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
                    {account.archived ? ' (archived)' : ''}
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
        </fieldset>
        <WriteError message={error} />
        <div className="flex flex-wrap items-center justify-end gap-2">
          {transaction === null || beforeSave !== undefined ? null : confirmingDelete ? (
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
              disabled={busy || closedForEdit.length > 0 || closePending}
              onClick={() => {
                setConfirmingDelete(true);
              }}
            >
              Delete
            </Button>
          )}
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
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
          <Button type="submit" disabled={busy || closedForEdit.length > 0}>
            {busy
              ? 'Saving…'
              : closePending
                ? 'Retry closing month'
                : transaction === null
                  ? 'Record'
                  : beforeSave === undefined
                    ? 'Save changes'
                    : 'Restore previous values'}
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
            <Textarea
              {...control}
              rows={6}
              className="font-mono"
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
            <div
              role="region"
              aria-label="Statement import preview"
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Justification: keyboard users need to reach the scrollable statement preview.
              tabIndex={0}
              className={cn('max-h-64 min-w-0 overflow-auto', focusRing)}
            >
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
