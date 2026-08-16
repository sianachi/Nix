import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../../app';
import { item, stubCoreApi } from '../../api-stub';
import { renderAt, signedIn } from '../../render-with-router';
import { aView } from '../../view-fixture';

const DESTINATION = item({
  id: '4a4a4a4a-4444-4444-8444-4a4a4a4a4a4a',
  title: 'Product planning',
});

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => {
      values.clear();
    },
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

beforeEach(() => {
  signedIn();
  vi.stubGlobal('sessionStorage', memoryStorage());
});

describe('the guided creation studio', () => {
  it('keeps the chosen destination visible and restores an unfinished tab draft', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [DESTINATION] });
    const url = `/new/board?parent=${DESTINATION.id}`;
    const first = renderAt(<App />, url);

    expect(await screen.findByText(/creating in product planning/i)).toBeVisible();
    const name = screen.getByRole('textbox', { name: /name/i });
    await user.clear(name);
    await user.type(name, 'Launch workflow');
    first.unmount();

    renderAt(<App />, url);
    expect(await screen.findByRole('textbox', { name: /name/i })).toHaveValue('Launch workflow');
  });

  it('starts Interactive Form with its full designer and a response companion', async () => {
    const user = userEvent.setup();
    stubCoreApi();
    renderAt(<App />, '/new/interactive-form');

    await screen.findByRole('heading', { name: /new interactive form/i });
    await user.click(screen.getByRole('button', { name: /continue/i }));

    expect(screen.getByRole('region', { name: /interactive form designer/i })).toBeVisible();
    expect(screen.getByRole('heading', { name: /form flow/i })).toBeVisible();
    expect(screen.getByRole('checkbox', { name: /publish a public response link/i })).toBeVisible();

    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByRole('combobox', { name: /companion/i })).toHaveValue('list');
  });

  it('loads an existing view into the same guided configuration flow', async () => {
    const view = aView({
      id: 'delivery-board',
      name: 'Delivery board',
      kind: 'board',
      groupBy: 'status',
      groupOrder: ['Planned', 'Shipped'],
    });
    stubCoreApi({
      items: [DESTINATION],
      views: { [DESTINATION.id]: { views: [view], default: view.id } },
    });

    renderAt(<App />, `/items/${DESTINATION.id}/views/${view.id}/edit/board`);

    expect(await screen.findByRole('heading', { name: /edit board/i })).toBeVisible();
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: /name/i })).toHaveValue('Delivery board');
    });
    expect(screen.getByRole('heading', { name: /delivery board/i })).toBeVisible();
  });
});
