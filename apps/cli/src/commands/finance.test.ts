import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { outputOptions } from '../output.ts';
import {
  actual,
  add,
  addAccount,
  addLine,
  budget,
  importStatement,
  month,
  seed,
  setTransaction,
  setup,
} from './finance.ts';

import { resolveSession } from './shared.ts';

vi.mock('./shared.ts', () => ({
  resolveSession: vi.fn(() => {
    throw new Error('Validation must not open a session.');
  }),
}));

beforeEach(() => {
  vi.mocked(resolveSession).mockImplementation(() => {
    throw new Error('Validation must not open a session.');
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

const ROOT = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const LINE = '33333333-3333-4333-8333-333333333333';
const OUTPUT = outputOptions(true, { isTTY: false });

const PLAN = {
  settings: {
    currency: 'GBP',
    startMonth: '2026-08',
    horizonMonths: 2,
    openingCash: 1200,
    emergencyFundMonths: 3,
    timezone: 'Europe/London',
  },
  accounts: [{ key: 'bank', name: 'Bank', type: 'current' as const }],
  lines: [
    {
      key: 'groceries',
      name: 'Groceries',
      section: 'Living',
      flow: 'expense' as const,
      account: 'bank',
      amount: 300,
    },
  ],
  transactions: [
    {
      key: 'aug-groceries',
      date: '2026-08-12',
      description: 'Market',
      amount: -42.5,
      account: 'bank',
      line: 'groceries',
    },
  ],
  closedMonths: ['2026-08'],
};

function mockSeedSession(execute: (endpoint: { operation: string; body?: unknown }) => unknown) {
  const query = vi
    .fn()
    .mockRejectedValue(
      Object.assign(new Error('not configured'), { code: 'finance.not_configured' }),
    );
  const executeMock = vi.fn((endpoint: { operation: string; body?: unknown }) =>
    Promise.resolve(execute(endpoint)),
  );
  vi.mocked(resolveSession).mockResolvedValue({ client: { query, execute: executeMock } } as never);
  return { query, execute: executeMock };
}

describe('finance CLI validation', () => {
  it('refuses a start month that is not yyyy-MM before opening a session', async () => {
    await expect(
      setup(
        undefined,
        ROOT,
        {
          currency: 'GBP',
          startMonth: '2026/08',
          horizon: '17',
          openingCash: '2000',
          emergencyMonths: '3',
          timezone: 'Europe/London',
        },
        OUTPUT,
      ),
    ).rejects.toThrow('--start-month');
  });

  it('refuses a currency that is not a three-letter code', async () => {
    await expect(
      setup(
        undefined,
        ROOT,
        {
          currency: 'pounds',
          startMonth: '2026-08',
          horizon: '17',
          openingCash: '0',
          emergencyMonths: '3',
          timezone: 'Europe/London',
        },
        OUTPUT,
      ),
    ).rejects.toThrow('--currency');
  });

  it('refuses an amount with more than two decimal places', async () => {
    await expect(
      add(
        undefined,
        ROOT,
        { amount: '-12.405', description: 'Example shop', account: ACCOUNT },
        OUTPUT,
      ),
    ).rejects.toThrow('--amount');
    await expect(
      add(undefined, ROOT, { amount: '0', description: 'Nothing', account: ACCOUNT }, OUTPUT),
    ).rejects.toThrow('--amount must be non-zero');
  });

  it('refuses an unknown account type and an unknown flow', async () => {
    await expect(
      addAccount(undefined, ROOT, { name: 'Jar', type: 'piggy_bank' }, OUTPUT),
    ).rejects.toThrow('--type');
    await expect(
      addLine(
        undefined,
        ROOT,
        { name: 'Rent', section: 'Housing', flow: 'sideways', account: ACCOUNT },
        OUTPUT,
      ),
    ).rejects.toThrow('--flow');
  });

  it('reads overrides as yyyy-MM=amount and refuses anything else', async () => {
    await expect(
      addLine(
        undefined,
        ROOT,
        {
          name: 'Salary',
          section: 'Income',
          flow: 'income',
          account: ACCOUNT,
          override: ['2027-04:4500'],
        },
        OUTPUT,
      ),
    ).rejects.toThrow('--override');
  });

  it('refuses a budget window that runs backwards', async () => {
    await expect(
      budget(undefined, ROOT, { from: '2026-09', to: '2026-08' }, OUTPUT),
    ).rejects.toThrow('--from must be on or before --to');
  });

  it('validates an actual before opening a session', async () => {
    await expect(
      actual(undefined, ROOT, LINE, '2026-13', { amount: '10' }, OUTPUT),
    ).rejects.toThrow('month must be a real month');
    await expect(
      actual(undefined, ROOT, LINE, '2026-09', { amount: '-1' }, OUTPUT),
    ).rejects.toThrow('--amount must be zero or more');
    await expect(
      actual(undefined, ROOT, LINE, '2026-09', { amount: '10', date: '2026-10-01' }, OUTPUT),
    ).rejects.toThrow('--date must fall in 2026-09');
  });

  it('refuses closing and reopening in one call', async () => {
    await expect(
      month(undefined, ROOT, '2026-08', { close: true, reopen: true }, OUTPUT),
    ).rejects.toThrow('--close or --reopen');
  });

  it('refuses an empty statement file', async () => {
    await expect(
      importStatement(undefined, ROOT, { account: ACCOUNT, file: 'empty.csv' }, OUTPUT, {
        read: () => Promise.resolve('  \n'),
      }),
    ).rejects.toThrow('empty.csv is empty');
  });

  it('validates transaction replacements before opening a session', async () => {
    await expect(
      setTransaction(
        undefined,
        ROOT,
        '33333333-3333-4333-8333-333333333333',
        {
          amount: '10.001',
          description: 'Market',
          account: ACCOUNT,
          date: '2026-08-12',
          cleared: 'false',
        },
        OUTPUT,
      ),
    ).rejects.toThrow('--amount');
    await expect(
      setTransaction(
        undefined,
        ROOT,
        '33333333-3333-4333-8333-333333333333',
        {
          amount: '10',
          description: 'Market',
          account: ACCOUNT,
          date: '2026-02-30',
          cleared: 'false',
        },
        OUTPUT,
      ),
    ).rejects.toThrow('--date');
    expect(resolveSession).not.toHaveBeenCalled();
  });

  it('sends transaction replacements through the finance API client', async () => {
    const execute = vi.fn().mockResolvedValue({ id: '33333333-3333-4333-8333-333333333333' });
    vi.mocked(resolveSession).mockResolvedValue({ client: { execute } } as never);
    await setTransaction(
      undefined,
      ROOT,
      '33333333-3333-4333-8333-333333333333',
      {
        amount: '-12.40',
        description: ' Market ',
        account: ACCOUNT,
        line: '44444444-4444-4444-8444-444444444444',
        date: '2026-08-12',
        cleared: 'true',
      },
      OUTPUT,
    );
    const endpoint = execute.mock.calls[0]?.[0] as { operation: string; body: unknown };
    expect(endpoint.operation).toBe('finance.setTransaction');
    expect(endpoint.body).toMatchObject({
      description: 'Market',
      date: '2026-08-12',
      amount: -12.4,
      accountId: ACCOUNT,
      lineId: '44444444-4444-4444-8444-444444444444',
      cleared: true,
    });
  });

  it('refuses a plan whose lines name accounts the plan does not define', async () => {
    const plan = {
      settings: {
        currency: 'GBP',
        startMonth: '2026-08',
        horizonMonths: 17,
        openingCash: 2000,
        emergencyFundMonths: 3,
        timezone: 'Europe/London',
      },
      accounts: [{ key: 'current', name: 'Example current account', type: 'current' }],
      lines: [
        {
          name: 'Rent',
          section: 'Housing',
          flow: 'expense',
          account: 'missing-account',
          amount: 900,
        },
      ],
    };
    await expect(
      seed(undefined, ROOT, { file: 'plan.json' }, OUTPUT, {
        read: () => Promise.resolve(JSON.stringify(plan)),
      }),
    ).rejects.toThrow("Line 'Rent' names unknown account 'missing-account'");
  });

  it('rejects duplicate keys, settlement cycles, invalid dates and money before opening a session', async () => {
    await expect(
      seed(undefined, ROOT, { file: 'plan.json' }, OUTPUT, {
        read: () =>
          Promise.resolve(
            JSON.stringify({ ...PLAN, accounts: [...PLAN.accounts, PLAN.accounts[0]] }),
          ),
      }),
    ).rejects.toThrow("Duplicate account key 'bank'");
    await expect(
      seed(undefined, ROOT, { file: 'plan.json' }, OUTPUT, {
        read: () =>
          Promise.resolve(
            JSON.stringify({
              ...PLAN,
              accounts: [
                { key: 'a', name: 'A', type: 'current', settlesFrom: 'b' },
                { key: 'b', name: 'B', type: 'current', settlesFrom: 'a' },
              ],
            }),
          ),
      }),
    ).rejects.toThrow('cycle');
    await expect(
      seed(undefined, ROOT, { file: 'plan.json' }, OUTPUT, {
        read: () =>
          Promise.resolve(
            JSON.stringify({
              ...PLAN,
              transactions: [{ ...PLAN.transactions[0], date: '2026-02-30' }],
            }),
          ),
      }),
    ).rejects.toThrow('real calendar day');
    await expect(
      seed(undefined, ROOT, { file: 'plan.json' }, OUTPUT, {
        read: () =>
          Promise.resolve(
            JSON.stringify({ ...PLAN, transactions: [{ ...PLAN.transactions[0], amount: 0.001 }] }),
          ),
      }),
    ).rejects.toThrow('at most two decimal places');
    await expect(
      seed(undefined, ROOT, { file: 'plan.json' }, OUTPUT, {
        read: () =>
          Promise.resolve(
            JSON.stringify({
              ...PLAN,
              transactions: [PLAN.transactions[0], { ...PLAN.transactions[0] }],
            }),
          ),
      }),
    ).rejects.toThrow("Duplicate transaction key 'aug-groceries'");
    await expect(
      seed(undefined, ROOT, { file: 'plan.json' }, OUTPUT, {
        read: () =>
          Promise.resolve(
            JSON.stringify({
              ...PLAN,
              accounts: [...PLAN.accounts, { key: 'savings', name: 'Savings', type: 'savings' }],
              transactions: [{ ...PLAN.transactions[0], account: 'savings' }],
            }),
          ),
      }),
    ).rejects.toThrow("does not match line 'groceries' account 'bank'");
    expect(resolveSession).not.toHaveBeenCalled();
  });

  it('requires actuals or an explicit zero-activity month before closing', async () => {
    await expect(
      seed(undefined, ROOT, { file: 'plan.json' }, OUTPUT, {
        read: () => Promise.resolve(JSON.stringify({ ...PLAN, transactions: [] })),
      }),
    ).rejects.toThrow("Closed month '2026-08' needs at least one transaction");
    const session = mockSeedSession((endpoint) => {
      if (endpoint.operation === 'finance.createAccount') return { id: ACCOUNT };
      if (endpoint.operation === 'finance.createLine')
        return { id: '33333333-3333-4333-8333-333333333333' };
      return {};
    });
    await seed(undefined, ROOT, { file: 'plan.json' }, OUTPUT, {
      read: () =>
        Promise.resolve(
          JSON.stringify({ ...PLAN, transactions: [], zeroActivityMonths: ['2026-08'] }),
        ),
    });
    expect(session.execute.mock.calls.at(-1)?.[0].operation).toBe('finance.setMonth');
    expect(resolveSession).toHaveBeenCalledOnce();
  });

  it('maps keyed transactions and imports actuals before closing their month', async () => {
    const sequence: string[] = [];
    const session = mockSeedSession((endpoint) => {
      sequence.push(endpoint.operation);
      if (endpoint.operation === 'finance.createAccount') return { id: ACCOUNT };
      if (endpoint.operation === 'finance.createLine')
        return { id: '33333333-3333-4333-8333-333333333333' };
      return {};
    });
    await seed(undefined, ROOT, { file: 'plan.json' }, OUTPUT, {
      read: () => Promise.resolve(JSON.stringify(PLAN)),
    });
    expect(session.query).toHaveBeenCalledOnce();
    expect(sequence).toEqual([
      'finance.setSettings',
      'finance.createAccount',
      'finance.createLine',
      'finance.createTransaction',
      'finance.setMonth',
    ]);
    const actual = session.execute.mock.calls.find(
      ([endpoint]) => endpoint.operation === 'finance.createTransaction',
    )?.[0];
    expect(actual?.body).toMatchObject({
      description: 'Market',
      date: '2026-08-12',
      amount: -42.5,
      accountId: ACCOUNT,
      lineId: '33333333-3333-4333-8333-333333333333',
    });
  });

  it('does not close a month when importing any transaction fails', async () => {
    const sequence: string[] = [];
    mockSeedSession((endpoint) => {
      sequence.push(endpoint.operation);
      if (endpoint.operation === 'finance.createAccount') return { id: ACCOUNT };
      if (endpoint.operation === 'finance.createLine')
        return { id: '33333333-3333-4333-8333-333333333333' };
      if (endpoint.operation === 'finance.createTransaction')
        throw new Error('transaction rejected');
      return {};
    });
    await expect(
      seed(undefined, ROOT, { file: 'plan.json' }, OUTPUT, {
        read: () => Promise.resolve(JSON.stringify(PLAN)),
      }),
    ).rejects.toThrow(
      /stopped while importing transaction 'aug-groceries'.*fresh root.*transaction rejected/,
    );
    expect(sequence).not.toContain('finance.setMonth');
  });

  it('refuses to seed a configured root before any writes', async () => {
    const execute = vi.fn();
    vi.mocked(resolveSession).mockResolvedValue({
      client: {
        query: vi
          .fn()
          .mockResolvedValue({ transactionCount: 0, accounts: [], lines: [], closedMonths: [] }),
        execute,
      },
    } as never);
    await expect(
      seed(undefined, ROOT, { file: 'plan.json' }, OUTPUT, {
        read: () => Promise.resolve(JSON.stringify(PLAN)),
      }),
    ).rejects.toThrow('already configured');
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a plan that is not a plan', async () => {
    await expect(
      seed(undefined, ROOT, { file: 'plan.json' }, OUTPUT, {
        read: () => Promise.resolve('{"settings":{}}'),
      }),
    ).rejects.toThrow('plan.json is not a finance plan');
  });
});
