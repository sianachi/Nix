import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Listbox, useListbox, type ListboxOption } from './Listbox';

const FRUIT: readonly ListboxOption[] = [
  { id: 'apple', label: 'Apple' },
  { id: 'apricot', label: 'Apricot' },
  { id: 'banana', label: 'Banana' },
];

/**
 * A caller, wired the way every real one is: a field that keeps the focus, a list that follows it.
 *
 * A real component rather than a `render` callback holding hooks - a callback is not a component,
 * so React's rules do not apply to it and the hooks would be a bug that happens to work.
 */
function Picker({
  options = FRUIT,
  onSelect = () => undefined,
  filter = false,
}: {
  readonly options?: readonly ListboxOption[];
  readonly onSelect?: (option: ListboxOption) => void;
  readonly filter?: boolean;
}): ReactNode {
  const [query, setQuery] = useState('');
  const shown = filter
    ? options.filter((option) => option.label.toLowerCase().includes(query.toLowerCase()))
    : options;
  const listbox = useListbox(shown, onSelect);

  return (
    <div>
      <input
        aria-label="Find a fruit"
        role="combobox"
        aria-expanded
        aria-controls={listbox.id}
        aria-activedescendant={listbox.activeOptionId}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
        }}
        onKeyDown={listbox.onKeyDown}
      />
      <Listbox
        label="Fruit"
        options={shown}
        controller={listbox}
        emptyMessage="No fruit matches that."
      />
    </div>
  );
}

/** The option the highlight is on, read the way assistive technology reads it. */
function highlighted(): HTMLElement | undefined {
  return screen.getAllByRole('option').find((option) => option.getAttribute('aria-selected') === 'true');
}

describe('a listbox driven from a text field', () => {
  it('keeps focus in the field and points at the highlighted option instead', async () => {
    // The property the whole component exists for. Moving focus into the list would take the
    // caret out of the field somebody is still typing into, and would announce every option as
    // whatever element it happened to be.
    const user = userEvent.setup();
    render(<Picker />);

    const field = screen.getByRole('combobox');
    await user.click(field);
    await user.keyboard('{ArrowDown}');

    expect(field).toHaveFocus();
    expect(field.getAttribute('aria-activedescendant')).toBe(highlighted()?.id);
  });

  it('starts on the first option so Enter alone commits the obvious answer', async () => {
    const chosen = vi.fn();
    const user = userEvent.setup();
    render(<Picker onSelect={chosen} />);

    await user.click(screen.getByRole('combobox'));
    await user.keyboard('{Enter}');

    expect(chosen).toHaveBeenCalledWith(FRUIT[0], 0);
  });

  it('moves the highlight down and up, and wraps at both ends', async () => {
    // A filtered list is short, and somebody holding the key expects to come back round rather
    // than stick against the end.
    const user = userEvent.setup();
    render(<Picker />);

    await user.click(screen.getByRole('combobox'));

    await user.keyboard('{ArrowUp}');
    expect(highlighted()).toHaveTextContent('Banana');

    await user.keyboard('{ArrowDown}');
    expect(highlighted()).toHaveTextContent('Apple');
  });

  it('jumps to the ends with Home and End', async () => {
    const user = userEvent.setup();
    render(<Picker />);

    await user.click(screen.getByRole('combobox'));

    await user.keyboard('{End}');
    expect(highlighted()).toHaveTextContent('Banana');

    await user.keyboard('{Home}');
    expect(highlighted()).toHaveTextContent('Apple');
  });

  it('leaves every other key to the field it is attached to', async () => {
    // Attaching a key handler to somebody's text input and swallowing their typing is the failure
    // mode here, so it is asserted rather than assumed.
    const user = userEvent.setup();
    render(<Picker />);

    const field = screen.getByRole('combobox');
    await user.click(field);
    await user.keyboard('ap');

    expect(field).toHaveValue('ap');
  });

  it('does not handle Escape, so the innermost open layer can decide what closes', async () => {
    // The convention in the application is that the innermost open thing wins and stops the event.
    // A listbox that closed on Escape would take a dialog with it, or leave one behind.
    //
    // Asserted on the document, which is where the application's own layers listen, rather than on
    // a wrapper element - the wrapper would only prove the event was not stopped one node up.
    const escaped = vi.fn();
    document.addEventListener('keydown', escaped);
    const user = userEvent.setup();

    try {
      render(<Picker />);

      await user.click(screen.getByRole('combobox'));
      await user.keyboard('{Escape}');

      expect(escaped).toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', escaped);
    }
  });

  it('commits the option that was pressed', async () => {
    const chosen = vi.fn();
    const user = userEvent.setup();
    render(<Picker onSelect={chosen} />);

    await user.click(screen.getByRole('option', { name: /Banana/ }));

    expect(chosen).toHaveBeenCalledWith(FRUIT[2], 2);
  });

  it('brings the highlight back into range when the list shrinks under it', async () => {
    // Typing filters the list on every keystroke, so the highlight routinely points past the end
    // of what is left. Correcting it in an effect would leave one rendered frame - the one being
    // looked at - with a highlight on nothing.
    const user = userEvent.setup();
    render(<Picker filter />);

    const field = screen.getByRole('combobox');
    await user.click(field);
    await user.keyboard('{End}');
    expect(highlighted()).toHaveTextContent('Banana');

    await user.type(field, 'ap');

    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(highlighted()).toHaveTextContent('Apple');
  });

  it('says so when nothing matches, rather than showing an empty box', async () => {
    const user = userEvent.setup();
    render(<Picker filter />);

    await user.type(screen.getByRole('combobox'), 'zzz');

    expect(screen.getByRole('status')).toHaveTextContent('No fruit matches that.');
  });

  it('still resolves the field s aria-controls when nothing matches', async () => {
    // An id pointing at nothing is reported as a broken relationship rather than as "no results",
    // which is a worse answer than the empty list it was meant to avoid.
    const user = userEvent.setup();
    render(<Picker filter />);

    const field = screen.getByRole('combobox');
    await user.type(field, 'zzz');

    const controls = field.getAttribute('aria-controls') ?? '';
    expect(controls).not.toBe('');
    expect(document.getElementById(controls)).not.toBeNull();
    expect(field.getAttribute('aria-activedescendant')).toBeNull();
  });

  it('heads each group once, where it starts', () => {
    const grouped: readonly ListboxOption[] = [
      { id: 'go', label: 'Go to today', group: 'Commands' },
      { id: 'new', label: 'New note', group: 'Commands' },
      { id: 'plan', label: 'The plan', group: 'Items' },
    ];

    render(<Picker options={grouped} />);

    expect(screen.getByText('Commands')).toBeInTheDocument();
    expect(screen.getByText('Items')).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });
});
