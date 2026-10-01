import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderAt, signedIn } from '../../render-with-router';
import { aContainer, views } from '../../container-fixture';
import { aView } from '../../view-fixture';
import { ApiClientProvider } from '../../../api/api-client-provider';
import { AuthProvider } from '../../../auth/auth-provider';
import type { PropertyDefinition, View } from '../../../views/core/container-model';
import { describeInferredRule } from '../../../views/query/query-by-example';
import { QueryView } from '../../../views/query/query-view';

/**
 * Query by example, end to end over a stubbed run: tick the rows the list is meant to hold, ask for
 * filters, review them in the ordinary editor, and save through the ordinary view write - which is
 * the only moment the smart list changes.
 */

const SMART_LIST = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const WORKSPACE = 'dddddddd-4444-4444-8444-dddddddddddd';

vi.mock('../../../workspaces/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: WORKSPACE }),
  useOptionalWorkspace: () => ({ workspaceId: WORKSPACE }),
}));

const CATEGORY: PropertyDefinition = {
  key: 'category',
  label: 'Category',
  type: 'select',
  options: ['Bills', 'Errands', 'Health'],
  required: false,
};

const PRIORITY: PropertyDefinition = {
  key: 'priority',
  label: 'Priority',
  type: 'priority',
  options: [],
  required: false,
};

const LIST: View = aView({ id: 'query', name: 'Everything', kind: 'query', filters: [] });

function row(index: number, title: string, category: string): unknown {
  return {
    id: `bbbbbbbb-2222-4222-8222-${String(index).padStart(12, '0')}`,
    workspaceId: WORKSPACE,
    containerId: null,
    containerTitle: null,
    title,
    type: 'note',
    properties: { title, category },
  };
}

const ROWS = [
  row(1, 'Rent', 'Bills'),
  row(2, 'Water', 'Bills'),
  row(3, 'Groceries', 'Errands'),
  row(4, 'Dentist', 'Health'),
];

let runs = 0;

beforeEach(() => {
  signedIn();
  runs = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL) => {
      const url = typeof input === 'string' ? input : input.href;
      if (url.endsWith('/auth/token')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ accessToken: 'token', expiresAt: '2099-01-01T00:00:00.000Z' }),
            { headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      runs += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            itemId: SMART_LIST,
            viewId: 'query',
            today: '2026-10-01',
            results: ROWS,
            limit: 500,
            truncated: false,
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );
    }),
  );
});

function renderList(setViews = vi.fn((): Promise<string | null> => Promise.resolve(null))) {
  renderAt(
    <AuthProvider>
      <ApiClientProvider>
        <QueryView
          container={aContainer({
            itemId: SMART_LIST,
            views: views([LIST]),
            setViews,
            schema: { properties: [CATEGORY, PRIORITY], declared: [], inherit: true },
          })}
          view={LIST}
          onOpen={vi.fn()}
        />
      </ApiClientProvider>
    </AuthProvider>,
  );
  return setViews;
}

async function tickAndSuggest(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Suggest filters from examples' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Use Rent as an example' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Use Water as an example' }));
  fireEvent.click(screen.getByRole('button', { name: 'Suggest filters' }));
}

describe('query by example', () => {
  it('proposes what the examples share into the filter editor, without saving it', async () => {
    const setViews = renderList();
    await tickAndSuggest();

    const panel = await screen.findByRole('region', { name: 'Filters suggested from examples' });
    expect(within(panel).getByText('Category is Bills - 2 of 4 remain')).toBeInTheDocument();
    // Focus moves to the proposal, so a keyboard or screen-reader user lands on what just appeared.
    expect(panel).toHaveFocus();
    expect(within(panel).getByRole('combobox', { name: 'Property' })).toHaveValue('category');
    expect(within(panel).getByRole('textbox', { name: 'Value' })).toHaveValue('Bills');
    expect(setViews).not.toHaveBeenCalled();
  });

  it('saves the reviewed rules through the view write and re-runs the list', async () => {
    const setViews = renderList();
    await tickAndSuggest();
    const before = runs;

    fireEvent.click(await screen.findByRole('button', { name: 'Save filters' }));

    await waitFor(() => {
      expect(setViews).toHaveBeenCalledWith([
        { ...LIST, filters: [{ property: 'category', operator: 'equals', value: 'Bills' }] },
      ]);
    });
    await waitFor(() => {
      expect(runs).toBeGreaterThan(before);
    });
    expect(
      screen.queryByRole('region', { name: 'Filters suggested from examples' }),
    ).not.toBeInTheDocument();
  });

  it('keeps the proposal open and says why when the save is refused', async () => {
    renderList(vi.fn(() => Promise.resolve('That could not be saved.')));
    await tickAndSuggest();

    fireEvent.click(await screen.findByRole('button', { name: 'Save filters' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('That could not be saved.');
    expect(
      screen.getByRole('region', { name: 'Filters suggested from examples' }),
    ).toBeInTheDocument();
  });

  it('discards the proposal without touching the list', async () => {
    const setViews = renderList();
    await tickAndSuggest();

    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));

    expect(
      screen.queryByRole('region', { name: 'Filters suggested from examples' }),
    ).not.toBeInTheDocument();
    expect(setViews).not.toHaveBeenCalled();
  });

  it('says so when the examples share nothing that narrows the list', async () => {
    renderList();
    fireEvent.click(await screen.findByRole('button', { name: 'Suggest filters from examples' }));
    // Every row ticked: nothing can narrow a list down to all of itself.
    for (const title of ['Rent', 'Water', 'Groceries', 'Dentist']) {
      fireEvent.click(screen.getByRole('checkbox', { name: `Use ${title} as an example` }));
    }
    fireEvent.click(screen.getByRole('button', { name: 'Suggest filters' }));

    expect(await screen.findByText(/there is no filter to suggest/)).toBeInTheDocument();
  });

  it('keeps one button label and says whether picking is on with aria-pressed', async () => {
    renderList();
    const toggle = await screen.findByRole('button', { name: 'Suggest filters from examples' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(toggle);

    expect(screen.getByRole('button', { name: 'Suggest filters from examples' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('a proposed rule in words', () => {
  it('names the property by its label and a priority by its scale word', () => {
    expect(
      describeInferredRule(
        { property: 'priority', operator: 'equals', value: '1', remaining: 3 },
        10,
        [PRIORITY],
      ),
    ).toBe('Priority is 1 - Urgent - 3 of 10 remain');
  });

  it('falls back to the key for a property the schema does not declare', () => {
    expect(
      describeInferredRule(
        { property: 'mood', operator: 'not-equals', value: 'grim', remaining: 1 },
        2,
        [],
      ),
    ).toBe('mood is not grim - 1 of 2 remain');
  });

  it('names a person by the member lookup it is given, never by identifier', () => {
    const OWNER: PropertyDefinition = {
      key: 'owner',
      label: 'Owner',
      type: 'assignee',
      options: [],
      required: false,
    };
    expect(
      describeInferredRule(
        { property: 'owner', operator: 'equals', value: 'subject-7', remaining: 2 },
        5,
        [OWNER],
        (subject) => (subject === 'subject-7' ? 'Ada Lovelace' : 'someone else'),
      ),
    ).toBe('Owner is Ada Lovelace - 2 of 5 remain');
  });

  it('formats a timestamp rule’s compared calendar day', () => {
    const expected = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeZone: 'UTC',
    }).format(Date.UTC(2026, 8, 1));
    expect(
      describeInferredRule(
        { property: 'updatedAt', operator: 'on', value: '2026-09-01', remaining: 1 },
        2,
        [{ key: 'updatedAt', label: 'Updated', type: 'timestamp', options: [], required: false }],
      ),
    ).toBe(`Updated is on ${expected} - 1 of 2 remain`);
  });

  it.each(['equals', 'not-equals', 'on-or-after', 'before'] as const)(
    'writes a %s date rule in the reader’s date format, on the stored calendar day',
    (operator) => {
      const DUE: PropertyDefinition = {
        key: 'due',
        label: 'Due',
        type: 'date',
        options: [],
        required: false,
      };
      const expected = new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeZone: 'UTC',
      }).format(Date.UTC(2026, 8, 1));

      expect(
        describeInferredRule({ property: 'due', operator, value: '2026-09-01', remaining: 4 }, 9, [
          DUE,
        ]),
      ).toContain(`${expected} - 4 of 9 remain`);
    },
  );
});
