import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { createInMemoryTokenStore } from '../auth.js';
import { createNixClient, type NixClient } from '../client.js';
import { server, TEST_BASE_URL, testUrl } from '../testing/server.js';
import { myDay } from './my-day.js';

const workspaceId = 'a1111111-1111-4111-8111-111111111111';
const itemId = 'a2222222-2222-4222-8222-222222222222';
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

describe('my day', () => {
  it('reads the workspace projection and keeps coverage and the habit day', async () => {
    server.use(
      http.get(testUrl(`/api/v1/workspaces/${workspaceId}/my-day`), () =>
        HttpResponse.json({
          workspaceId,
          evaluatedAt: '2026-10-16T12:00:00+00:00',
          taskDay: '2026-10-16',
          taskTimezone: 'UTC',
          tasks: {
            rows: [
              {
                itemId,
                containerId: null,
                containerTitle: null,
                title: 'Pay rent',
                section: 'today',
                dueDay: '2026-10-16',
                startDay: null,
                priority: 2,
                estimate: null,
                action: { kind: 'occurrence', key: null, occurredOn: '2026-10-16' },
              },
            ],
            coverage: { kind: 'partial', reasons: [{ code: 'candidate_limit', omitted: null }] },
            limits: { candidates: 200, rows: 100 },
          },
          habits: {
            rows: [
              {
                itemId,
                containerId: null,
                containerTitle: 'Habits',
                title: 'Stretch',
                timezone: 'Pacific/Kiritimati',
                occurrence: {
                  date: '2026-10-17',
                  scheduled: true,
                  state: 'scheduled',
                  target: 1,
                  unit: 'times',
                  quantity: null,
                  completed: false,
                },
              },
            ],
            coverage: { kind: 'complete', reasons: [] },
            limits: { candidates: 24, rows: 24 },
          },
        }),
      ),
    );

    const day = await client.query(myDay(workspaceId));

    expect(day.tasks.coverage.reasons).toEqual([{ code: 'candidate_limit', omitted: null }]);
    expect(day.tasks.rows[0]?.action).toEqual({
      kind: 'occurrence',
      key: null,
      occurredOn: '2026-10-16',
    });
    expect(day.habits.rows[0]?.occurrence.date).toBe('2026-10-17');
  });
});
