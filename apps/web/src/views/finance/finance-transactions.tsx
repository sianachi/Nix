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
  cn,
  focusRing,
  type TableColumn,
} from '@nix/ui';
import {
  finance as financeApi,
  type Finance,
  type FinanceTransaction,
  type FinanceTransactions as Transactions,
} from '@nix/api-client';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useOptionalApiClient } from '../../api/api-client-provider';
import { ErrorPanel, LoadingPanel, PartialNotice } from '../../components/states/status-panels';
import { Money, SectionHeading, WriteError, editableTextButton } from './finance-shared';
import { formatDay, monthOf, parseAmount, shiftMonth } from './money';
import { useFinanceQuery, type FinanceState } from './use-finance';
import { ImportDialog } from './finance-import-dialog';
import { QuickAddDialog, TransactionDialog, linesBySection } from './transaction-dialog';

// Importers reach these through this module.
export { QuickAddDialog, TransactionDialog };

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
