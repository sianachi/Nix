import { render, screen, waitFor, within } from '@testing-library/react';
import { NixApiError } from '@nix/api-client';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { ChartView } from '../../../views/chart/chart-view';
import { aContainer } from '../../container-fixture';
import { aView } from '../../view-fixture';

/**
 * The chart view: bars over every child, not over the loaded page.
 *
 * The assertions that matter are the honest-state ones. A chart is a summary, and a summary that
 * quietly leaves something out is worse than no summary: the unset bucket has to be drawn, a
 * truncated chart has to say so, and the numbers have to be readable as text rather than only as
 * lengths.
 */

const query = vi.hoisted(() => vi.fn());

vi.mock('../../../api/api-client-provider', () => ({
  useApiClient: () => ({ query }),
}));

function chartOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    itemId: '11111111-1111-4111-8111-111111111111',
    viewId: 'v1',
    groupBy: 'status',
    measure: 'count',
    measureProperty: null,
    buckets: [
      { value: 'Todo', children: 6, total: null },
      { value: 'Done', children: 3, total: null },
      { value: null, children: 1, total: null },
    ],
    children: 10,
    distinctValues: 3,
    truncated: false,
    ...over,
  };
}

function answer(body: unknown, ok = true, status = 200): void {
  if (ok) {
    query.mockResolvedValue(body);
    return;
  }

  query.mockRejectedValue(
    status === 404
      ? NixApiError.fromStatus(status)
      : NixApiError.fromProblemDetails(status, body as { code: string }),
  );
}

function renderChart(): void {
  render(
    <ChartView
      container={aContainer({ itemId: '11111111-1111-4111-8111-111111111111' })}
      view={aView({ id: 'v1', kind: 'chart', groupBy: 'status' })}
      onOpen={vi.fn()}
    />,
  );
}

beforeEach(() => {
  query.mockReset();
  answer(chartOf());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the chart view', () => {
  it('draws a row per bucket with the figure as text', async () => {
    renderChart();

    const todo = await screen.findByRole('row', { name: /todo/i });
    expect(within(todo).getByText('6')).toBeVisible();
  });

  it('draws the children with no value as their own bucket', async () => {
    // A container half of whose children have no status is mostly a container of unset things.
    // Dropping that bucket would misreport every proportion drawn beside it.
    renderChart();

    const unset = await screen.findByRole('row', { name: /unset/i });
    expect(within(unset).getByText('1')).toBeVisible();
  });

  it('says how many items it summarised, so the figures have a denominator', async () => {
    renderChart();

    expect(await screen.findByText(/Counted across all 10 items inside this one/)).toBeVisible();
  });

  it('says so when more groups exist than it drew', async () => {
    answer(chartOf({ truncated: true, distinctValues: 42 }));
    renderChart();

    expect(await screen.findByText(/largest 3 of 42 groups/i)).toBeVisible();
  });

  it('says a container with nothing in it has nothing to summarise', async () => {
    answer(chartOf({ buckets: [], children: 0, distinctValues: 0 }));
    renderChart();

    expect(await screen.findByText(/Nothing to summarise yet/i)).toBeVisible();
  });

  it('says an unfinished chart is unfinished rather than drawing nothing', async () => {
    // An empty chart sends somebody looking for their missing items; the refusal sends them to the
    // configuration that is actually incomplete.
    answer({ code: 'chart.not_configured' }, false, 422);
    renderChart();

    expect(await screen.findByText(/needs a property to group by/i)).toBeVisible();
  });

  it('offers a retry when the chart could not be read at all', async () => {
    answer({ code: 'items.not_found' }, false, 404);
    renderChart();

    expect(await screen.findByRole('button', { name: /try again/i })).toBeVisible();
  });

  it('names the totalled property when the bars total one', async () => {
    answer(
      chartOf({
        measure: 'sum',
        measureProperty: 'estimate',
        buckets: [{ value: 'Todo', children: 6, total: 18 }],
        distinctValues: 1,
      }),
    );
    renderChart();

    await waitFor(() => {
      expect(screen.getByRole('columnheader', { name: 'estimate' })).toBeVisible();
    });
    expect(screen.getByText('18')).toBeVisible();
  });
});
