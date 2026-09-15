import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { createInMemoryTokenStore } from '../auth.js';
import { createNixClient, type NixClient } from '../client.js';
import { server, TEST_BASE_URL, testUrl } from '../testing/server.js';
import { checkIn, readHabit, setHabit, undoCheckIn } from './habits.js';

const habitId = 'a1111111-1111-4111-8111-111111111111';
const checkInId = 'a2222222-2222-4222-8222-222222222222';
const settings = {
  frequency: 'daily' as const,
  weekdays: [],
  timezone: 'Europe/London',
  startDate: '2026-09-14',
  target: 20,
  unit: 'minutes',
};
const row = { id: checkInId, occurredOn: '2026-09-14', completed: true, quantity: 20 };
const tracker = { habitId, ...settings, checkIns: [], weeks: [] };
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

describe('habit history requests', () => {
  it('keeps date ranges separate and invalidates history after check-in and undo', async () => {
    let reads = 0;
    let completed = false;
    server.use(
      http.get(testUrl(`/api/v1/items/${habitId}/habit`), ({ request }) => {
        reads += 1;
        const from = new URL(request.url).searchParams.get('from');
        return HttpResponse.json({
          ...tracker,
          checkIns: completed && from === row.occurredOn ? [row] : [],
        });
      }),
      http.put(
        testUrl(`/api/v1/items/${habitId}/habit/check-ins/${row.occurredOn}`),
        async ({ request }) => {
          expect(await request.json()).toEqual({ completed: true, quantity: 20 });
          completed = true;
          return HttpResponse.json(row);
        },
      ),
      http.delete(testUrl(`/api/v1/items/${habitId}/habit/check-ins/${row.occurredOn}`), () => {
        completed = false;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const query = readHabit(habitId, '2026-09-14', '2026-09-20');
    expect((await client.query(query)).checkIns).toEqual([]);
    await client.execute(checkIn(habitId, row.occurredOn, { completed: true, quantity: 20 }));
    const afterWrite = await client.queryResult(query);
    expect(afterWrite.revalidation).not.toBeNull();
    await afterWrite.revalidation;
    expect((await client.query(query)).checkIns).toEqual([row]);
    expect((await client.query(readHabit(habitId, '2026-09-21', '2026-09-27'))).checkIns).toEqual(
      [],
    );
    await client.execute(undoCheckIn(habitId, row.occurredOn));
    const afterUndo = await client.queryResult(query);
    expect(afterUndo.revalidation).not.toBeNull();
    await afterUndo.revalidation;
    expect((await client.query(query)).checkIns).toEqual([]);
    expect(reads).toBe(4);
  });

  it('surfaces invalid server history rather than presenting an empty tracker', async () => {
    server.use(
      http.get(testUrl(`/api/v1/items/${habitId}/habit`), () =>
        HttpResponse.json({ ...tracker, checkIns: [{ ...row, quantity: -1 }] }),
      ),
    );
    await expect(client.query(readHabit(habitId, '2026-09-14', '2026-09-20'))).rejects.toThrow();
  });

  it('round-trips settings and keeps the server-confirmed schedule', async () => {
    server.use(
      http.put(testUrl(`/api/v1/items/${habitId}/habit`), async ({ request }) => {
        expect(await request.json()).toEqual(settings);
        return HttpResponse.json(tracker);
      }),
    );
    expect(await client.execute(setHabit(habitId, settings))).toEqual({
      ...tracker,
      status: 'active',
      occurrences: null,
      progress: null,
      months: null,
    });
  });
});
