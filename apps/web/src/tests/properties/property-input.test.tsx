import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { Item, PropertyDefinition } from '../../views/core/container-model';
import { PropertyInput } from '../../properties/property-input';
import {
  useWorkspaceMembers,
  type WorkspaceMember,
  type WorkspaceMembersState,
} from '../../settings/use-workspace-members';

/**
 * The hook is mocked at the module boundary rather than driven through a real fetch: everything
 * this file needs to assert is how `PropertyInput` renders each of the hook's states, not how the
 * hook itself reaches them - that read is `use-workspace-members.ts`'s own concern and is exercised
 * end to end by `members-section.test.tsx`.
 */
vi.mock('../../settings/use-workspace-members', () => ({
  useWorkspaceMembers: vi.fn(),
}));

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
    hasChildren: false,
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

  it('renders at cell density without a second border', () => {
    render(
      <PropertyInput
        item={itemWith({ owner: 'Ada' })}
        property={propertyOf({ key: 'owner', label: 'Owner' })}
        onCommit={vi.fn()}
        density="cell"
      />,
    );

    // The column header is the label, so the control names itself after its row instead - and the
    // cell already has a rule under it, so a framed box inside it would read as a double rule.
    const control = screen.getByRole('textbox', { name: 'Owner for Kickoff' });
    expect(control).toHaveClass('border-transparent');
    expect(screen.queryByText('Owner')).not.toBeInTheDocument();
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

  it('edits a due date and a start date through the same day-only control a date gets', () => {
    // The task types refine meaning, never representation: the text that arrives is the text that
    // goes back, exactly as the plain date test above establishes.
    render(
      <>
        <PropertyInput
          item={itemWith({ due_date: '2026-09-01' })}
          property={propertyOf({ key: 'due_date', label: 'Due', type: 'due_date' })}
          onCommit={vi.fn()}
        />
        <PropertyInput
          item={itemWith({ start_date: '2026-08-25' })}
          property={propertyOf({ key: 'start_date', label: 'Begins', type: 'start_date' })}
          onCommit={vi.fn()}
        />
      </>,
    );

    expect(screen.getByLabelText('Due')).toHaveValue('2026-09-01');
    expect(screen.getByLabelText('Begins')).toHaveValue('2026-08-25');
  });

  it('edits completion as a checkbox that stores true or false', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({ completion: false })}
        property={propertyOf({ key: 'completion', label: 'Done', type: 'completion' })}
        onCommit={onCommit}
      />,
    );

    await person.click(screen.getByRole('checkbox', { name: 'Done' }));

    expect(onCommit).toHaveBeenCalledWith(true);
  });

  it('offers priority as the closed four-step scale, storing the number', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({ priority: 3 })}
        property={propertyOf({ key: 'priority', label: 'Urgency', type: 'priority' })}
        onCommit={onCommit}
      />,
    );

    const control = screen.getByRole('combobox', { name: 'Urgency' });
    const options = within(control).getAllByRole('option');
    // Four levels plus the way back to none; chosen, never typed, so the 0 and the 7 the server
    // refuses are not offerable here.
    expect(options).toHaveLength(5);

    await person.selectOptions(control, '1');
    expect(onCommit).toHaveBeenCalledWith(1);
  });

  it('edits an estimate as a number, storing a number rather than its text', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({})}
        property={propertyOf({ key: 'estimate', label: 'Hours', type: 'estimate' })}
        onCommit={onCommit}
      />,
    );

    const box = screen.getByRole('spinbutton', { name: 'Hours' });
    await person.type(box, '2.5');
    await person.keyboard('{Enter}');

    expect(onCommit).toHaveBeenCalledWith(2.5);
  });
});

describe('an assignee property', () => {
  const ada: WorkspaceMember = {
    subjectType: 'principal',
    subjectId: '44444444-bbbb-4bbb-8bbb-444444444444',
    subjectDisplayName: 'Ada Lovelace',
    role: 'owner',
    grantedAt: '2026-01-05T09:00:00+00:00',
  };

  const grace: WorkspaceMember = {
    subjectType: 'principal',
    subjectId: '55555555-bbbb-4bbb-8bbb-555555555555',
    subjectDisplayName: 'Grace Hopper',
    role: 'editor',
    grantedAt: '2026-03-12T09:00:00+00:00',
  };

  function membersState(overrides: Partial<WorkspaceMembersState> = {}): WorkspaceMembersState {
    return {
      status: 'ready',
      members: [],
      truncated: false,
      error: null,
      reload: vi.fn(),
      ...overrides,
    };
  }

  it('offers the workspace members and a way back to unassigned', () => {
    vi.mocked(useWorkspaceMembers).mockReturnValue(membersState({ members: [ada, grace] }));

    render(
      <PropertyInput
        item={itemWith({ owner: ada.subjectId })}
        property={propertyOf({ key: 'owner', label: 'Owner', type: 'assignee' })}
        onCommit={vi.fn()}
      />,
    );

    const control = screen.getByRole('combobox', { name: 'Owner' });

    // The same word a plain select clears through, not a second one invented for people.
    expect(
      within(control)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Unset', 'Ada Lovelace', 'Grace Hopper']);
    expect(control).toHaveValue(ada.subjectId);
  });

  it("commits the chosen person's identifier, not their name", async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();
    vi.mocked(useWorkspaceMembers).mockReturnValue(membersState({ members: [ada, grace] }));

    render(
      <PropertyInput
        item={itemWith({})}
        property={propertyOf({ key: 'owner', label: 'Owner', type: 'assignee' })}
        onCommit={onCommit}
      />,
    );

    await person.selectOptions(screen.getByRole('combobox', { name: 'Owner' }), 'Grace Hopper');

    expect(onCommit).toHaveBeenCalledWith(grace.subjectId);
  });

  it('clears back to unassigned rather than leaving a mistake permanent', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();
    vi.mocked(useWorkspaceMembers).mockReturnValue(membersState({ members: [ada] }));

    render(
      <PropertyInput
        item={itemWith({ owner: ada.subjectId })}
        property={propertyOf({ key: 'owner', label: 'Owner', type: 'assignee' })}
        onCommit={onCommit}
      />,
    );

    await person.selectOptions(screen.getByRole('combobox', { name: 'Owner' }), 'Unset');

    expect(onCommit).toHaveBeenCalledWith(null);
  });

  it('says it is loading rather than showing an empty list that looks like nobody is here', () => {
    vi.mocked(useWorkspaceMembers).mockReturnValue(membersState({ status: 'loading' }));

    render(
      <PropertyInput
        item={itemWith({})}
        property={propertyOf({ key: 'owner', label: 'Owner', type: 'assignee' })}
        onCommit={vi.fn()}
      />,
    );

    expect(screen.getByText(/loading the workspace members/i)).toBeVisible();
  });

  it('says a failed member read failed, and still shows what is stored', () => {
    vi.mocked(useWorkspaceMembers).mockReturnValue(
      membersState({ status: 'error', error: 'Core could not be reached.' }),
    );

    render(
      <PropertyInput
        item={itemWith({ owner: ada.subjectId })}
        property={propertyOf({ key: 'owner', label: 'Owner', type: 'assignee' })}
        onCommit={vi.fn()}
      />,
    );

    // The read failing is not a reason to also hide what the item holds.
    expect(screen.getByText(/core could not be reached/i)).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Owner' })).toHaveValue(ada.subjectId);
  });

  it('shows an identifier the member list does not carry as the current value, not dropped or mislabelled', () => {
    const strangerId = '99999999-bbbb-4bbb-8bbb-999999999999';
    vi.mocked(useWorkspaceMembers).mockReturnValue(membersState({ members: [ada] }));

    render(
      <PropertyInput
        item={itemWith({ owner: strangerId })}
        property={propertyOf({ key: 'owner', label: 'Owner', type: 'assignee' })}
        onCommit={vi.fn()}
      />,
    );

    const control = screen.getByRole('combobox', { name: 'Owner' });

    // Neither dropped (the value stays selected, not "Unset") nor mislabelled (its own identifier,
    // never Ada's name) - the honest answer when the list cannot vouch for who this is.
    expect(control).toHaveValue(strangerId);
    expect(within(control).getByRole('option', { name: strangerId })).toBeInTheDocument();
  });
});
