import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { EffectiveSchema, PropertyDefinition, View } from '../../views/container-model';
import { aContainer, views as offered } from '../../views/container-fixture';
import type { ContainerData } from '../../views/use-container';
import { ViewEditor } from '../../views/view-editor';

/**
 * Adding and configuring the ways a folder can be looked at.
 *
 * This is the screen that closes the gap between "the server can store a board" and "a person can
 * make one". The assertions worth having are about what it refuses to offer: a board cannot be
 * grouped by a property that could not produce columns, and a calendar cannot be placed by
 * something that is not a date, because a view configured that way renders nothing and looks like
 * an empty folder.
 */

function propertyOf(overrides: Partial<PropertyDefinition> & { key: string }): PropertyDefinition {
  return { label: overrides.key, type: 'text', options: [], required: false, ...overrides };
}

function viewOf(overrides: Partial<View> & { id: string; name: string }): View {
  return {
    kind: 'list',
    columns: [],
    groupBy: null,
    groupOrder: [],
    dateProperty: null,
    sortBy: null,
    sortDescending: false,
    mode: null,
    coverProperty: null,
    endDateProperty: null,
    ...overrides,
  };
}

const SCHEMA: EffectiveSchema = {
  properties: [
    propertyOf({ key: 'status', label: 'Status', type: 'select', options: ['Todo', 'Done'] }),
    propertyOf({ key: 'due', label: 'Due', type: 'date' }),
    propertyOf({ key: 'owner', label: 'Owner' }),
  ],
  declared: [],
  inherit: true,
};

function containerOf(
  views: readonly View[],
  setViews: (next: readonly View[]) => Promise<string | null> = () => Promise.resolve(null),
  schema: EffectiveSchema | null = SCHEMA,
): ContainerData {
  return aContainer({
    schema,
    views: offered(views),
    setViews,
  });
}

describe('the view editor', () => {
  it('says what a folder with no views will do', () => {
    render(<ViewEditor container={containerOf([])} open onClose={vi.fn()} />);

    // Not an empty box. Somebody opening this needs to know that no views is a working state
    // rather than a broken one.
    expect(screen.getByText(/no views yet/i)).toBeVisible();
  });

  it('adds a view', async () => {
    const user = userEvent.setup();
    const setViews = vi.fn(() => Promise.resolve(null));

    render(<ViewEditor container={containerOf([], setViews)} open onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /add a view/i }));
    await user.click(screen.getByRole('button', { name: /save views/i }));

    // The second argument is the point: the first view an item is given becomes what it opens on.
    // Without it, somebody builds a board and the screen does not change - the item keeps opening
    // on its document because that is what it had always said.
    expect(setViews).toHaveBeenCalledWith(
      [expect.objectContaining({ kind: 'list' })],
      expect.any(String),
    );
  });

  it('leaves the default alone once an item already offers views', async () => {
    const user = userEvent.setup();
    const setViews = vi.fn(() => Promise.resolve(null));

    render(
      <ViewEditor
        container={containerOf([viewOf({ id: 'existing', name: 'Everything' })], setViews)}
        open
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: /add a view/i }));
    await user.click(screen.getByRole('button', { name: /save views/i }));

    // Once there are views, "document" is a choice somebody can have made deliberately, and adding
    // a second view must not overrule it.
    expect(setViews).toHaveBeenCalledWith(expect.any(Array));
  });

  it('offers only select properties to group a board by', () => {
    render(
      <ViewEditor
        container={containerOf([viewOf({ id: 'b', name: 'Board', kind: 'board' })])}
        open
        onClose={vi.fn()}
      />,
    );

    const grouping = screen.getByRole('combobox', { name: /group by/i });

    // Grouping by free text would produce a column per distinct value, and by a date a column per
    // day. Neither is a board anybody can read.
    expect(within(grouping).getByRole('option', { name: 'Status' })).toBeInTheDocument();
    expect(within(grouping).queryByRole('option', { name: 'Owner' })).not.toBeInTheDocument();
    expect(within(grouping).queryByRole('option', { name: 'Due' })).not.toBeInTheDocument();
  });

  it('offers only date properties to place a calendar by', () => {
    render(
      <ViewEditor
        container={containerOf([viewOf({ id: 'c', name: 'Calendar', kind: 'calendar' })])}
        open
        onClose={vi.fn()}
      />,
    );

    const placement = screen.getByRole('combobox', { name: /place by/i });

    expect(within(placement).getByRole('option', { name: 'Due' })).toBeInTheDocument();
    expect(within(placement).queryByRole('option', { name: 'Status' })).not.toBeInTheDocument();
  });

  it('offers a timeline both ends of its span, and says which one it can do without', () => {
    // The one behaviour the registry's array-of-configurations shape was justified by, asserted
    // where it actually happens. A test over the registry data proves the table has two entries; it
    // does not prove this form draws two blocks, which is what a refactor of the configuration loop
    // could break silently.
    render(
      <ViewEditor
        container={containerOf([viewOf({ id: 't', name: 'Delivery', kind: 'timeline' })])}
        open
        onClose={vi.fn()}
      />,
    );

    const start = screen.getByRole('combobox', { name: /starts on/i });
    const end = screen.getByRole('combobox', { name: /ends on/i });

    // Both take the same property types, because the server's requirement for a timeline is the
    // calendar's verbatim.
    for (const control of [start, end]) {
      expect(within(control).getByRole('option', { name: 'Due' })).toBeInTheDocument();
      expect(within(control).queryByRole('option', { name: 'Status' })).not.toBeInTheDocument();
    }

    // The wording is the whole distinction: the view is waiting on a start, and is complete without
    // an end. "Choose a property" on the second would read as an unfinished view.
    expect(within(start).getByRole('option', { name: 'Choose a property' })).toBeInTheDocument();
    expect(within(end).getByRole('option', { name: 'None' })).toBeInTheDocument();
  });

  it('carries the date property across when a calendar becomes a timeline', async () => {
    // What keeps `dateProperty` under the calendar's name rather than being renamed to something a
    // timeline would prefer. Switching the kind must not be the thing that loses the configuration.
    const user = userEvent.setup();
    const setViews = vi.fn(() => Promise.resolve(null));

    render(
      <ViewEditor
        container={containerOf(
          [viewOf({ id: 'c', name: 'When', kind: 'calendar', dateProperty: 'due' })],
          setViews,
        )}
        open
        onClose={vi.fn()}
      />,
    );

    await user.selectOptions(screen.getByRole('combobox', { name: /shown as/i }), 'timeline');

    expect(screen.getByRole('combobox', { name: /starts on/i })).toHaveValue('due');

    await user.click(screen.getByRole('button', { name: /save views/i }));

    expect(setViews).toHaveBeenCalledWith([
      expect.objectContaining({ kind: 'timeline', dateProperty: 'due' }),
    ]);
  });

  it('says how to fix a folder with nothing a board could group by', () => {
    render(
      <ViewEditor
        container={containerOf([viewOf({ id: 'b', name: 'Board', kind: 'board' })], undefined, {
          properties: [propertyOf({ key: 'owner', label: 'Owner' })],
          declared: [],
          inherit: true,
        })}
        open
        onClose={vi.fn()}
      />,
    );

    // A disabled dropdown with no explanation is a dead end. This names the next step.
    expect(screen.getByText(/no select property yet.*add one under properties/i)).toBeVisible();
  });

  it('shows the configuration a kind needs and nothing it does not', async () => {
    const user = userEvent.setup();

    render(
      <ViewEditor
        container={containerOf([viewOf({ id: 'v', name: 'View', kind: 'list' })])}
        open
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByRole('combobox', { name: /group by/i })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: /shown as/i }), 'board');
    expect(screen.getByRole('combobox', { name: /group by/i })).toBeVisible();
    expect(screen.queryByRole('combobox', { name: /place by/i })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: /shown as/i }), 'calendar');
    expect(screen.getByRole('combobox', { name: /place by/i })).toBeVisible();
    expect(screen.queryByRole('combobox', { name: /group by/i })).not.toBeInTheDocument();
  });

  it('records the property a board groups by', async () => {
    const user = userEvent.setup();
    const setViews = vi.fn(() => Promise.resolve(null));

    render(
      <ViewEditor
        container={containerOf([viewOf({ id: 'b', name: 'Board', kind: 'board' })], setViews)}
        open
        onClose={vi.fn()}
      />,
    );

    await user.selectOptions(screen.getByRole('combobox', { name: /group by/i }), 'status');
    await user.click(screen.getByRole('button', { name: /save views/i }));

    expect(setViews).toHaveBeenCalledWith([expect.objectContaining({ groupBy: 'status' })]);
  });

  it('clears the column list when the grouping property changes', async () => {
    const user = userEvent.setup();
    const setViews = vi.fn(() => Promise.resolve(null));

    render(
      <ViewEditor
        container={containerOf(
          [
            viewOf({
              id: 'b',
              name: 'Board',
              kind: 'board',
              groupBy: 'owner',
              groupOrder: ['Ada', 'Grace'],
            }),
          ],
          setViews,
        )}
        open
        onClose={vi.fn()}
      />,
    );

    await user.selectOptions(screen.getByRole('combobox', { name: /group by/i }), 'status');
    await user.click(screen.getByRole('button', { name: /save views/i }));

    // The old column list named values of a different property. Carried across, the board would
    // show columns nothing can ever land in.
    expect(setViews).toHaveBeenCalledWith([
      expect.objectContaining({ groupBy: 'status', groupOrder: [] }),
    ]);
  });

  it('keeps a view identifier stable across a rename', async () => {
    const user = userEvent.setup();
    const setViews = vi.fn(() => Promise.resolve(null));

    render(
      <ViewEditor
        container={containerOf([viewOf({ id: 'by-status', name: 'By status' })], setViews)}
        open
        onClose={vi.fn()}
      />,
    );

    await user.clear(screen.getByRole('textbox', { name: /name/i }));
    await user.type(screen.getByRole('textbox', { name: /name/i }), 'Pipeline');
    await user.click(screen.getByRole('button', { name: /save views/i }));

    // A shared link names the view. Renaming it must not break somebody else's link.
    expect(setViews).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'by-status', name: 'Pipeline' }),
    ]);
  });

  it('reorders views, because the order is the switcher', async () => {
    const user = userEvent.setup();
    const setViews = vi.fn(() => Promise.resolve(null));

    render(
      <ViewEditor
        container={containerOf(
          [viewOf({ id: 'first', name: 'First' }), viewOf({ id: 'second', name: 'Second' })],
          setViews,
        )}
        open
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: /move second earlier/i }));
    await user.click(screen.getByRole('button', { name: /save views/i }));

    expect(setViews).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'second' }),
      expect.objectContaining({ id: 'first' }),
    ]);
  });

  it('removes a view', async () => {
    const user = userEvent.setup();
    const setViews = vi.fn(() => Promise.resolve(null));

    render(
      <ViewEditor
        container={containerOf([viewOf({ id: 'gone', name: 'Gone' })], setViews)}
        open
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: /remove gone/i }));
    await user.click(screen.getByRole('button', { name: /save views/i }));

    expect(setViews).toHaveBeenCalledWith([]);
  });

  it('shows the server s refusal and stays open', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(
      <ViewEditor
        container={containerOf([viewOf({ id: 'b', name: 'Board', kind: 'board' })], () =>
          Promise.resolve("'Board': a board needs a property to group by."),
        )}
        open
        onClose={onClose}
      />,
    );

    await user.click(screen.getByRole('button', { name: /save views/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/needs a property to group by/i);
    expect(onClose).not.toHaveBeenCalled();
  });
});
