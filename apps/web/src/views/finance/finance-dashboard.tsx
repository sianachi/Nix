import { Button, Tag, Text } from '@nix/ui';
import {
  finance as financeApi,
  type Finance,
  type FinanceDashboard as Dashboard,
} from '@nix/api-client';
import { useMemo, type ReactNode } from 'react';
import { ErrorPanel, LoadingPanel, PartialNotice } from '../../components/states/status-panels';
import type { FinanceSection } from './finance-view';
import { Meter, Money, Tile } from './finance-shared';
import { formatDay, formatMonth, formatPercent } from './money';
import { useFinanceQuery, type FinanceState } from './use-finance';

/** The month's position, the cards, the loans, what needs watching and what is due soon. */
export function FinanceDashboard({
  state,
  finance,
  month,
  onSection,
}: {
  readonly state: FinanceState;
  readonly finance: Finance;
  readonly month: string;
  readonly onSection: (section: FinanceSection) => void;
}): ReactNode {
  const itemId = finance.itemId;
  const endpoint = useMemo(() => financeApi.readDashboard(itemId, month), [itemId, month]);
  const query = useFinanceQuery<Dashboard>(endpoint, state.generation);
  const currency = finance.settings.currency;
  if (query.data === null) {
    return query.status === 'error' ? (
      <ErrorPanel title="The dashboard could not be loaded" detail={query.error ?? ''} />
    ) : (
      <LoadingPanel label="dashboard" />
    );
  }
  const dashboard = query.data;
  const bufferFraction =
    dashboard.emergencyTarget > 0 ? dashboard.position.netPosition / dashboard.emergencyTarget : 0;
  return (
    <div className="flex flex-col gap-6" aria-labelledby="finance-dashboard-title">
      <Text as="h3" variant="h3" id="finance-dashboard-title" className="sr-only">
        Dashboard for {formatMonth(month, 'long')}
      </Text>
      {query.status === 'error' ? <PartialNotice pending="the latest figures" /> : null}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile
          label={`Net ${formatMonth(month)}`}
          value={<Money amount={dashboard.actual.net} currency={currency} round />}
          caption={
            <>
              <Money amount={dashboard.plan.net} currency={currency} round /> planned
              {dashboard.savingsRateActual === null
                ? ''
                : `, saving ${formatPercent(dashboard.savingsRateActual)} of income`}
            </>
          }
        />
        <Tile
          label="Net position"
          value={<Money amount={dashboard.position.netPosition} currency={currency} round />}
          caption={
            <>
              Bank <Money amount={dashboard.position.closingBank} currency={currency} round /> less{' '}
              <Money amount={dashboard.position.cardOwed} currency={currency} round /> owed to cards
            </>
          }
        />
        <Tile
          label="Card float to hold"
          value={<Money amount={dashboard.cardFloat} currency={currency} round />}
          caption="Spent on cards, collected next month. Not savings."
        />
        <Tile
          label={`Position at ${formatMonth(dashboard.horizonEnd.month)}`}
          value={<Money amount={dashboard.horizonEnd.netPosition} currency={currency} round />}
          caption={
            <>
              <Money amount={dashboard.horizonNet} currency={currency} round signed /> over the plan
            </>
          }
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="flex flex-col gap-3" aria-labelledby="finance-watch-title">
          <Text as="h4" variant="h5" id="finance-watch-title">
            Watch
          </Text>
          {dashboard.watch.length === 0 ? (
            <Text variant="bodySmall" tone="muted">
              Nothing is over its plan this month.
            </Text>
          ) : (
            <ul className="flex flex-col gap-2">
              {dashboard.watch.map((item) => (
                <li
                  key={item.lineId ?? 'unassigned'}
                  className="flex items-center justify-between gap-3 rounded-lg bg-surface-raised p-3"
                >
                  <div className="min-w-0">
                    <Text as="p" variant="bodySmall" className="truncate font-medium">
                      {item.name}
                    </Text>
                    <Text variant="caption" tone="muted">
                      {item.lineId === null ? (
                        'Recorded against no budget line'
                      ) : (
                        <>
                          <Money amount={item.actual} currency={currency} /> of{' '}
                          <Money amount={item.plan} currency={currency} /> planned
                        </>
                      )}
                    </Text>
                  </div>
                  <Tag tone="accent">
                    <Money amount={item.variance} currency={currency} signed /> over
                  </Tag>
                </li>
              ))}
            </ul>
          )}
          <Button
            variant="ghost"
            onClick={() => {
              onSection('budget');
            }}
          >
            Open the budget
          </Button>
        </section>

        <section className="flex flex-col gap-3" aria-labelledby="finance-upcoming-title">
          <Text as="h4" variant="h5" id="finance-upcoming-title">
            Due in the next two weeks
          </Text>
          {dashboard.upcoming.length === 0 ? (
            <Text variant="bodySmall" tone="muted">
              Nothing scheduled is due in the next fourteen days.
            </Text>
          ) : (
            <ul className="flex flex-col gap-2">
              {dashboard.upcoming.map((item) => (
                <li
                  key={`${item.kind}:${item.lineId ?? item.accountId ?? ''}:${item.due}`}
                  className="flex items-center justify-between gap-3 rounded-lg bg-surface-raised p-3"
                >
                  <div className="min-w-0">
                    <Text as="p" variant="bodySmall" className="truncate font-medium">
                      {item.name}
                    </Text>
                    <Text variant="caption" tone="muted">
                      {formatDay(item.due)}
                      {item.kind === 'line' ? (item.posted ? ', posted' : ', not yet posted') : ''}
                    </Text>
                  </div>
                  <Text as="span" variant="bodySmall">
                    <Money amount={item.amount} currency={currency} />
                  </Text>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="flex flex-col gap-3" aria-labelledby="finance-buffer-title">
        <Text as="h4" variant="h5" id="finance-buffer-title">
          Emergency fund
        </Text>
        {dashboard.emergencyTarget <= 0 ? (
          <Text variant="bodySmall" tone="muted">
            No emergency target is set. Choose months of outgoings under Settings.
          </Text>
        ) : (
          <div className="flex flex-col gap-2 rounded-lg bg-surface-raised p-3">
            <Text as="p" variant="bodySmall">
              <Money amount={dashboard.position.netPosition} currency={currency} round /> of{' '}
              <Money amount={dashboard.emergencyTarget} currency={currency} round />
              {dashboard.bufferMetIn === null
                ? ', not reached inside the plan'
                : `, reached in ${formatMonth(dashboard.bufferMetIn)}`}
            </Text>
            <Meter fraction={bufferFraction} label="Emergency fund progress" />
            <Text variant="caption" tone="muted">
              Once the buffer is held, surplus can go to the loan; the loan page shows what an
              overpayment buys.
            </Text>
          </div>
        )}
      </section>

      {dashboard.cards.length === 0 && dashboard.loans.length === 0 ? null : (
        <div className="grid gap-6 lg:grid-cols-2">
          {dashboard.cards.length === 0 ? null : (
            <section className="flex flex-col gap-3" aria-labelledby="finance-cards-title">
              <Text as="h4" variant="h5" id="finance-cards-title">
                Cards
              </Text>
              <ul className="flex flex-col gap-2">
                {dashboard.cards.map((card) => (
                  <li key={card.accountId} className="rounded-lg bg-surface-raised p-3">
                    <div className="flex items-center justify-between gap-3">
                      <Text as="p" variant="bodySmall" className="font-medium">
                        {card.name}
                      </Text>
                      {card.utilisation === null ? (
                        <Tag tone="muted">No limit set</Tag>
                      ) : (
                        <Tag tone={card.utilisation > 0.3 ? 'accent' : 'neutral'}>
                          {formatPercent(card.utilisation)} used
                        </Tag>
                      )}
                    </div>
                    <Text variant="caption" tone="muted">
                      Spent <Money amount={card.spend} currency={currency} /> this month;{' '}
                      <Money amount={card.paymentOut} currency={currency} /> collected;{' '}
                      <Money amount={card.closing} currency={currency} /> owed at month end
                    </Text>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {dashboard.loans.length === 0 ? null : (
            <section className="flex flex-col gap-3" aria-labelledby="finance-loans-title">
              <Text as="h4" variant="h5" id="finance-loans-title">
                Loans
              </Text>
              <ul className="flex flex-col gap-2">
                {dashboard.loans.map((loan) => (
                  <li key={loan.accountId} className="rounded-lg bg-surface-raised p-3">
                    <Text as="p" variant="bodySmall" className="font-medium">
                      {loan.name}
                    </Text>
                    <Text variant="caption" tone="muted">
                      <Money amount={loan.balance} currency={currency} /> left
                      {loan.clearedIn === null
                        ? ', not cleared inside the schedule'
                        : `, cleared ${formatMonth(loan.clearedIn)}`}
                      ; <Money amount={loan.totalInterest} currency={currency} round /> interest in
                      all
                    </Text>
                  </li>
                ))}
              </ul>
              <Button
                variant="ghost"
                onClick={() => {
                  onSection('accounts');
                }}
              >
                Try an overpayment
              </Button>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
