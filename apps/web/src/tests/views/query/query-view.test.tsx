import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderAt, signedIn } from '../../render-with-router';
import { aContainer } from '../../container-fixture';
import { aView } from '../../view-fixture';
import { ApiClientProvider } from '../../../api/api-client-provider';
import { AuthProvider } from '../../../auth/auth-provider';
import type { View } from '../../../views/core/container-model';
import { QueryView } from '../../../views/query/query-view';

/**
 * The query view, driven against a stubbed run endpoint: the five states, the container names on
 * the rows, and the truncation sentence. The rows come from the server rather than from
 * `container.children`, which is the kind's whole point - so the stub is the endpoint, not the
 * container.
 */

const SMART_LIST = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ROW_ONE = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const ROW_TWO = 'cccccccc-3333-4333-8333-cccccccccccc';
const WORKSPACE = 'dddddddd-4444-4444-8444-dddddddddddd';
const TRACKER = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';

const OVERDUE_VIEW: View = aView({
  id: 'query',
  name: 'Overdue',
  kind: 'query',
  filters: [
    { property: 'due', operator: 'before', value: 'today' },
    { property: 'done', operator: 'not-equals', value: 'true' },
  ],
});

function row(id: string, title: string, due: string): unknown {
  return {
    id,
    workspaceId: WORKSPACE,
    containerId: TRACKER,
    containerTitle: 'Tracker',
    title,
    type: 'note',
    properties: { title, due },
  };
}

function stubRun(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL) => {
      const url = typeof input === 'string' ? input : input.href;
      if (url.endsWith('/auth/token')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              accessToken: 'core-session-token',
              expiresAt: '2099-01-01T00:00:00.000Z',
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      if (!url.includes('/query?view=')) {
        return Promise.reject(new Error(`Unexpected request: ${url}`));
      }
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: {
            'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
          },
        }),
      );
    }),
  );
}

function results(rows: readonly unknown[], truncated = false): unknown {
  return {
    itemId: SMART_LIST,
    viewId: 'query',
    today: '2026-08-15',
    results: rows,
    limit: 500,
    truncated,
  };
}

function renderQueryView(view: View = OVERDUE_VIEW, onOpen = vi.fn()): ReturnType<typeof vi.fn> {
  renderAt(
    <AuthProvider>
      <ApiClientProvider>
        <QueryView container={aContainer({ itemId: SMART_LIST })} view={view} onOpen={onOpen} />
      </ApiClientProvider>
    </AuthProvider>,
  );
  return onOpen;
}

beforeEach(() => {
  signedIn();
});

describe('the smart list', () => {
  it('shows each match with the container it lives in and the values it matched on', async () => {
    stubRun(results([row(ROW_ONE, 'Water plants', '2026-08-10')]));
    renderQueryView();

    expect(await screen.findByRole('button', { name: 'Water plants' })).toBeInTheDocument();
    expect(screen.getByText('in Tracker')).toBeInTheDocument();
    expect(screen.getByText('2026-08-10')).toBeInTheDocument();
  });

  it('opens a row where it lives', async () => {
    stubRun(results([row(ROW_ONE, 'Water plants', '2026-08-10')]));
    const onOpen = renderQueryView();

    fireEvent.click(await screen.findByRole('button', { name: 'Water plants' }));

    expect(onOpen).toHaveBeenCalledWith(ROW_ONE);
  });

  it('says nothing matches today, rather than claiming the list is empty of items', async () => {
    stubRun(results([]));
    renderQueryView();

    expect(await screen.findByText('Nothing matches today')).toBeInTheDocument();
    expect(screen.getByText(/refills as items change/)).toBeInTheDocument();
  });

  it('says when the ceiling cut the list', async () => {
    stubRun(results([row(ROW_ONE, 'A', '2026-08-01'), row(ROW_TWO, 'B', '2026-08-02')], true));
    renderQueryView();

    expect(
      await screen.findByText(/More items match than this list carries: the first 2 are shown\./),
    ).toBeInTheDocument();
  });

  it('reports a refusal in the server’s own terms and offers a retry', async () => {
    stubRun({ code: 'query.invalid_rules', detail: 'A stored filter no longer validates.' }, 422);
    renderQueryView();

    expect(
      await screen.findByText(/A stored filter no longer validates, so the query was not run/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('tells a routing 404 apart from a refusal', async () => {
    stubRun(null, 404);
    renderQueryView();

    expect(await screen.findByText(/the server does not offer/)).toBeInTheDocument();
  });
});
