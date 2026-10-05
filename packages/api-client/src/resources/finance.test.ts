import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { createInMemoryTokenStore } from '../auth.js';
import { createNixClient, type NixClient } from '../client.js';
import { server, TEST_BASE_URL, testUrl } from '../testing/server.js';
import {
  createTransaction,
  deleteTransaction,
  importStatement,
  listTransactions,
  postScheduled,
  readBudget,
  readDashboard,
  readFinance,
  setActual,
  setMonth,
} from './finance.js';

const rootId = 'b1111111-1111-4111-8111-111111111111';
const accountId = 'b2222222-2222-4222-8222-222222222222';
const lineId = 'b3333333-3333-4333-8333-333333333333';
const transactionId = 'b4444444-4444-4444-8444-444444444444';

const finance = {
  itemId: rootId,
  settings: {
    currency: 'GBP',
    startMonth: '2026-08',
    endMonth: '2027-12',
    horizonMonths: 17,
    openingCash: 2000,
    emergencyFundMonths: 3,
    timezone: 'Europe/London',
  },
  containers: { accounts: accountId, lines: lineId, transactions: transactionId },
  accounts: [
    {
      id: accountId,
      name: 'PrimaryCard',
      type: 'credit_card',
      limit: 3000,
      openingBalance: 100,
      settlesFrom: null,
      apr: null,
      payment: null,
      overpayment: null,
      target: null,
      archived: false,
    },
  ],
  lines: [
    {
      id: lineId,
      name: 'Groceries',
      section: 'PrimaryCard',
      flow: 'expense',
      accountId,
      amount: 200,
      overrides: { '2026-12': 300 },
      scheduled: false,
      dueDay: null,
      loanAccount: null,
      archived: false,
      position: 1,
    },
  ],
  closedMonths: [],
  currentMonth: '2026-09',
  transactionCount: 0,
  problems: [],
};
const transaction = {
  id: transactionId,
  description: 'Example shop',
  date: '2026-09-21',
  amount: -12.4,
  accountId,
  lineId,
  source: 'manual',
  postedFor: null,
  importKey: null,
  cleared: false,
};
let client: NixClient;

beforeEach(() => {
  client = createNixClient({
    baseUrl: TEST_BASE_URL,
    tokens: createInMemoryTokenStore({
      initialAccessToken: 'token',
      refresh: () => Promise.resolve(null),
    }),
  });
});

describe('finance requests', () => {
  it('reads the root and invalidates it after a transaction is recorded', async () => {
    let reads = 0;
    server.use(
      http.get(testUrl(`/api/v1/items/${rootId}/finance`), () => {
        reads += 1;
        return HttpResponse.json({ ...finance, transactionCount: reads - 1 });
      }),
      http.post(testUrl(`/api/v1/items/${rootId}/finance/transactions`), async ({ request }) => {
        expect(await request.json()).toEqual({
          description: 'Example shop',
          date: '2026-09-21',
          amount: -12.4,
          accountId,
          lineId,
        });
        return HttpResponse.json(transaction, { status: 201 });
      }),
    );
    expect((await client.query(readFinance(rootId))).transactionCount).toBe(0);
    expect((await client.query(readFinance(rootId))).transactionCount).toBe(0);
    const recorded = await client.execute(
      createTransaction(rootId, {
        description: 'Example shop',
        date: '2026-09-21',
        amount: -12.4,
        accountId,
        lineId,
      }),
    );
    expect(recorded.amount).toBe(-12.4);
    // Invalidation marks the entry stale; a forced read is what a hook does after a write.
    const refreshed = await client.query(readFinance(rootId), { forceRefresh: true });
    expect(refreshed.transactionCount).toBe(1);
    expect(reads).toBe(2);
  });

  it('sends month filters as query parameters and parses the budget grid', async () => {
    server.use(
      http.get(testUrl(`/api/v1/items/${rootId}/finance/transactions`), ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get('month')).toBe('2026-09');
        expect(url.searchParams.get('unassigned')).toBe('true');
        expect(url.searchParams.get('accountId')).toBeNull();
        return HttpResponse.json({ transactions: [transaction], total: 1, truncated: false });
      }),
      http.get(testUrl(`/api/v1/items/${rootId}/finance/budget`), ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get('from')).toBe('2026-08');
        expect(url.searchParams.get('to')).toBe('2026-09');
        const cell = { month: '2026-08', plan: 200, actual: 59, variance: -141, transactions: 1 };
        const figures = { income: 0, paidThisMonth: 0, cardSpend: 59, outgoings: 59, net: -59 };
        return HttpResponse.json({
          itemId: rootId,
          months: ['2026-08', '2026-09'],
          sections: [
            {
              name: 'PrimaryCard',
              flow: 'expense',
              lines: [{ line: finance.lines[0], cells: [cell, { ...cell, month: '2026-09' }] }],
              totals: [cell, { ...cell, month: '2026-09' }],
            },
          ],
          totals: [
            {
              month: '2026-08',
              closed: false,
              plan: figures,
              actual: figures,
              unassignedOutflow: 0,
              unassignedInflow: 0,
              unassignedTransactions: 0,
              cumulativeNetPlan: -200,
              cumulativeNetActual: -59,
            },
          ],
          accountId: url.searchParams.get('accountId'),
        });
      }),
    );
    const listed = await client.query(
      listTransactions(rootId, { month: '2026-09', unassigned: true }),
    );
    expect(listed.transactions[0]?.description).toBe('Example shop');
    const grid = await client.query(readBudget(rootId, '2026-08', '2026-09'));
    expect(grid.sections[0]?.lines[0]?.cells[0]?.variance).toBe(-141);
    expect(grid.accountId).toBeNull();
    const narrowed = await client.query(readBudget(rootId, '2026-08', '2026-09', accountId));
    expect(narrowed.accountId).toBe(accountId);
  });

  it("brings a line's actual to an amount and deletes a transaction", async () => {
    server.use(
      http.post(
        testUrl(`/api/v1/items/${rootId}/finance/lines/${lineId}/months/2026-09/actual`),
        async ({ request }) => {
          expect(await request.json()).toEqual({ amount: 100 });
          return HttpResponse.json({
            lineId,
            month: '2026-09',
            before: 59,
            after: 100,
            transaction: { ...transaction, amount: -41, description: 'Groceries adjustment' },
          });
        },
      ),
      http.delete(testUrl(`/api/v1/items/${rootId}/finance/transactions/${transactionId}`), () =>
        HttpResponse.text('', { status: 204 }),
      ),
    );
    const moved = await client.execute(setActual(rootId, lineId, '2026-09', { amount: 100 }));
    expect(moved.before).toBe(59);
    expect(moved.transaction?.amount).toBe(-41);
    await expect(client.execute(deleteTransaction(rootId, transactionId))).resolves.toBeUndefined();
  });

  it('closes a month, posts scheduled lines and previews an import', async () => {
    server.use(
      http.put(testUrl(`/api/v1/items/${rootId}/finance/months/2026-08`), async ({ request }) => {
        expect(await request.json()).toEqual({ closed: true });
        return HttpResponse.json({ month: '2026-08', closed: true, closedMonths: ['2026-08'] });
      }),
      http.post(testUrl(`/api/v1/items/${rootId}/finance/months/2026-09/post-scheduled`), () =>
        HttpResponse.json({
          month: '2026-09',
          posted: [transaction],
          alreadyPosted: 2,
          skipped: 0,
        }),
      ),
      http.post(testUrl(`/api/v1/items/${rootId}/finance/import`), async ({ request }) => {
        const body = (await request.json()) as { commit: boolean; csv: string };
        expect(body.commit).toBe(false);
        expect(body.csv).toContain('Date,Description,Amount');
        return HttpResponse.json({
          rows: 1,
          readable: 1,
          created: 1,
          duplicates: 0,
          matched: 0,
          unreadable: 0,
          committed: false,
          preview: [
            {
              row: 2,
              date: '2026-09-21',
              amount: -12.4,
              description: 'EXAMPLE SHOP',
              status: 'new',
              suggestedLineId: lineId,
              problem: null,
              transactionId: null,
            },
          ],
          problem: null,
        });
      }),
      http.get(testUrl(`/api/v1/items/${rootId}/finance/dashboard`), ({ request }) => {
        expect(new URL(request.url).searchParams.get('month')).toBe('2026-09');
        const figures = {
          income: 4000,
          paidThisMonth: 1500,
          cardSpend: 400,
          outgoings: 1900,
          net: 2100,
        };
        const position = {
          month: '2026-09',
          source: 'plan',
          income: 4000,
          paidThisMonth: 1500,
          cardSpend: 400,
          cardPaymentOut: 400,
          cashNet: 2100,
          closingBank: 6500,
          cardOwed: 400,
          netPosition: 6100,
          emergencyTarget: 5700,
          bufferMet: true,
        };
        return HttpResponse.json({
          itemId: rootId,
          month: '2026-09',
          closed: false,
          plan: figures,
          actual: figures,
          savingsRatePlan: 0.525,
          savingsRateActual: null,
          position,
          openingNetPosition: 1900,
          emergencyTarget: 5700,
          bufferMetIn: '2026-09',
          cardFloat: 400,
          cards: [],
          loans: [],
          watch: [],
          upcoming: [],
          horizonEnd: position,
          horizonNet: 38100,
        });
      }),
    );
    expect((await client.execute(setMonth(rootId, '2026-08', true))).closedMonths).toEqual([
      '2026-08',
    ]);
    expect((await client.execute(postScheduled(rootId, '2026-09'))).alreadyPosted).toBe(2);
    const preview = await client.execute(
      importStatement(rootId, {
        accountId,
        csv: 'Date,Description,Amount\n2026-09-21,EXAMPLE SHOP,-12.40\n',
        commit: false,
      }),
    );
    expect(preview.preview[0]?.suggestedLineId).toBe(lineId);
    expect((await client.query(readDashboard(rootId, '2026-09'))).bufferMetIn).toBe('2026-09');
  });
});
