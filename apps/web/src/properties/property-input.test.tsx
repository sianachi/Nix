import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { Item, PropertyDefinition } from '../views/container-model';
import { PropertyInput } from './property-input';

/**
 * One control per property type.
 *
 * Two of these assertions are the reason this component exists at all. The date one: a date
 * property carries no time and no zone, so the text that arrives has to be the text that goes back
 * - a field that made a Date out of it would hand back the day before for half the world. And the
 * unknown-type one: the contract calls a property type a string on purpose, so meeting one this
 * build has never heard of has to show the value rather than swallow it.
 */

function propertyOf(overrides: Partial<PropertyDefinition> & { key: string }): PropertyDefinition {
  return { label: overrides.key, type: 'text', options: [], required: false, ...overrides };
}

function itemWith(properties: Record<string, unknown>): Item {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    workspaceId: '22222222-2222-4222-8222-222222222222',
    parentId: '33333333-3333-4333-8333-333333333333',
    type: 'note',
    title: 'Kickoff',
    seq: 1,
    lifecycleState: 'active',
    properties,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('a property input', () => {
  it('gives a text property a text box', () => {
    render(
      <PropertyInput
        item={itemWith({ owner: 'Ada' })}
        property={propertyOf({ key: 'owner', label: 'Owner' })}
        onCommit={vi.fn()}
      />,
    );

    expect(screen.getByRole('textbox', { name: 'Owner' })).toHaveValue('Ada');
  });

  it('gives a number property a number box, and stores a number rather than its text', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({})}
        property={propertyOf({ key: 'points', label: 'Points', type: 'number' })}
        onCommit={onCommit}
      />,
    );

    await person.type(screen.getByRole('spinbutton', { name: 'Points' }), '8');
    await person.tab();

    expect(onCommit).toHaveBeenCalledWith(8);
  });

  it('gives a url property a url box', () => {
    render(
      <PropertyInput
        item={itemWith({ source: 'https://example.test/spec' })}
        property={propertyOf({ key: 'source', label: 'Source', type: 'url' })}
        onCommit={vi.fn()}
      />,
    );

    expect(screen.getByRole('textbox', { name: 'Source' })).toHaveAttribute('type', 'url');
  });

  it('gives a checkbox property a checkbox, and stores true or false', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({ shipped: false })}
        property={propertyOf({ key: 'shipped', label: 'Shipped', type: 'checkbox' })}
        onCommit={onCommit}
      />,
    );

    await person.click(screen.getByRole('checkbox', { name: 'Shipped' }));

    expect(onCommit).toHaveBeenCalledWith(true);
  });

  it('offers a select exactly the options the property declares, and a way back to none', () => {
    render(
      <PropertyInput
        item={itemWith({ status: 'Doing' })}
        property={propertyOf({
          key: 'status',
          label: 'Status',
          type: 'select',
          options: ['Todo', 'Doing', 'Done'],
        })}
        onCommit={vi.fn()}
      />,
    );

    const control = screen.getByRole('combobox', { name: 'Status' });

    // Exactly the declared options. Inventing one would offer a value the schema refuses, and
    // dropping one would hide a value somebody is entitled to choose.
    expect(
      within(control)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Unset', 'Todo', 'Doing', 'Done']);
    expect(control).toHaveValue('Doing');
  });

  it('still offers the value an item holds when the schema no longer declares it', () => {
    render(
      <PropertyInput
        item={itemWith({ status: 'Blocked' })}
        property={propertyOf({
          key: 'status',
          label: 'Status',
          type: 'select',
          options: ['Todo', 'Done'],
        })}
        onCommit={vi.fn()}
      />,
    );

    // Otherwise the control reports some other option as the current one, which is a lie about the
    // item rather than a gap in the schema.
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('Blocked');
  });

  it('clears a select back to nothing rather than leaving a mistake permanent', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({ status: 'Doing' })}
        property={propertyOf({
          key: 'status',
          label: 'Status',
          type: 'select',
          options: ['Todo', 'Doing'],
        })}
        onCommit={onCommit}
      />,
    );

    await person.selectOptions(screen.getByRole('combobox', { name: 'Status' }), '');

    // Null, because that is what the contract's merge reads as "clear this one".
    expect(onCommit).toHaveBeenCalledWith(null);
  });

  it('clears a text property by emptying it', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({ owner: 'Ada' })}
        property={propertyOf({ key: 'owner', label: 'Owner' })}
        onCommit={onCommit}
      />,
    );

    await person.clear(screen.getByRole('textbox', { name: 'Owner' }));
    await person.tab();

    expect(onCommit).toHaveBeenCalledWith(null);
  });

  it('gives a multi-select a checkbox per option and stores the list', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({ tags: ['Draft'] })}
        property={propertyOf({
          key: 'tags',
          label: 'Tags',
          type: 'multi_select',
          options: ['Draft', 'Review'],
        })}
        onCommit={onCommit}
      />,
    );

    const group = screen.getByRole('group', { name: 'Tags' });
    expect(within(group).getByRole('checkbox', { name: 'Draft' })).toBeChecked();

    await person.click(within(group).getByRole('checkbox', { name: 'Review' }));

    expect(onCommit).toHaveBeenCalledWith(['Draft', 'Review']);
  });

  it('clears a multi-select when its last option is unticked', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({ tags: ['Draft'] })}
        property={propertyOf({
          key: 'tags',
          label: 'Tags',
          type: 'multi_select',
          options: ['Draft', 'Review'],
        })}
        onCommit={onCommit}
      />,
    );

    await person.click(screen.getByRole('checkbox', { name: 'Draft' }));

    // Nothing selected and no value are the same fact, and the contract already has a way to say it.
    expect(onCommit).toHaveBeenCalledWith(null);
  });

  it('round-trips a date as the text it was stored as, with no zone in the way', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({ due: '2026-03-03' })}
        property={propertyOf({ key: 'due', label: 'Due', type: 'date' })}
        onCommit={onCommit}
      />,
    );

    const control = screen.getByLabelText('Due');

    // The stored text, unchanged. A field that made a Date of it would show the 2nd to anybody west
    // of Greenwich, which is the whole reason the value carries no time and no zone.
    expect(control).toHaveValue('2026-03-03');

    await person.clear(control);
    await person.type(control, '2026-12-31');
    await person.tab();

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('2026-12-31');
  });

  it('leaves a stored value that is not a date alone rather than offering to overwrite it', () => {
    render(
      <PropertyInput
        item={itemWith({ due: 'next Tuesday' })}
        property={propertyOf({ key: 'due', label: 'Due', type: 'date' })}
        onCommit={vi.fn()}
      />,
    );

    const control = screen.getByRole('textbox', { name: 'Due' });
    expect(control).toHaveValue('next Tuesday');
    expect(control).toHaveAttribute('readonly');
    expect(screen.getByText(/is not a date this field can show/)).toBeVisible();
  });

  it('shows a type it does not know as the value that is stored, read-only, and says so', () => {
    render(
      <PropertyInput
        item={itemWith({ rating: 4 })}
        property={propertyOf({ key: 'rating', label: 'Rating', type: 'stars' })}
        onCommit={vi.fn()}
      />,
    );

    // Property types are an open set by contract. Rendering nothing for one would hide a value
    // somebody stored behind a build that has not caught up.
    const control = screen.getByRole('textbox', { name: 'Rating' });
    expect(control).toHaveValue('4');
    expect(control).toHaveAttribute('readonly');
    expect(screen.getByText(/does not know the "stars" property type/)).toBeVisible();
  });

  it('marks a required property required', () => {
    render(
      <PropertyInput
        item={itemWith({})}
        property={propertyOf({ key: 'owner', label: 'Owner', required: true })}
        onCommit={vi.fn()}
      />,
    );

    expect(screen.getByRole('textbox', { name: 'Owner' })).toBeRequired();
  });

  it('does not write while somebody is typing', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({})}
        property={propertyOf({ key: 'owner', label: 'Owner' })}
        onCommit={onCommit}
      />,
    );

    await person.type(screen.getByRole('textbox', { name: 'Owner' }), 'Ada');

    // A request per keystroke is four requests to store one name, three of which store a value
    // nobody meant.
    expect(onCommit).not.toHaveBeenCalled();

    await person.tab();

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('Ada');
  });

  it('does not write when a field is left exactly as it was found', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({ owner: 'Ada' })}
        property={propertyOf({ key: 'owner', label: 'Owner' })}
        onCommit={onCommit}
      />,
    );

    await person.click(screen.getByRole('textbox', { name: 'Owner' }));
    await person.tab();

    // Otherwise tabbing through the panel writes every property on the way past.
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('shows a refusal against the control it belongs to', () => {
    render(
      <PropertyInput
        item={itemWith({})}
        property={propertyOf({ key: 'owner', label: 'Owner' })}
        onCommit={vi.fn()}
        error="'owner' is required."
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent("'owner' is required.");
    expect(screen.getByRole('textbox', { name: 'Owner' })).toHaveAttribute('aria-invalid', 'true');
  });

  it('does not offer to write anything when writing is not permitted', () => {
    render(
      <PropertyInput
        item={itemWith({ owner: 'Ada' })}
        property={propertyOf({ key: 'owner', label: 'Owner' })}
        onCommit={vi.fn()}
        disabled
      />,
    );

    expect(screen.getByRole('textbox', { name: 'Owner' })).toBeDisabled();
  });
});
