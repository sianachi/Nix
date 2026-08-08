import { useState, type ReactNode } from 'react';
import { type Meta, type StoryObj } from '@storybook/react-vite';
import {
  FileText,
  Heading1,
  List,
  Plus,
  Quote,
  Search,
  Table as TableIcon,
  Type,
} from 'lucide-react';

import { Blueprint } from '../primitives/Blueprint';
import { Input } from '../controls/Input';
import { Listbox, useListbox, type ListboxOption } from './Listbox';

/**
 * A filtered list of choices, driven from a text field that keeps the focus.
 *
 * The shape behind the block inserter, the item picker and the command palette. Focus stays in the
 * field and the highlight travels by `aria-activedescendant`, which is what lets somebody keep
 * typing while the list moves under them.
 */
const meta = {
  title: 'Patterns/Listbox',
  component: Listbox,
  // Controlled by design, and the controller can only come from the hook - so the default args
  // stand in for a caller that owns one. Every story below renders its own, because that is how it
  // is actually used and because a listbox with no live highlight is not the component.
  args: {
    label: 'Blocks',
    options: [],
    controller: {
      id: 'listbox-story-placeholder',
      activeIndex: 0,
      activeOptionId: undefined,
      setActiveIndex: () => undefined,
      select: () => undefined,
      onKeyDown: () => undefined,
    },
    emptyMessage: 'No block matches that.',
  },
} satisfies Meta<typeof Listbox>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * A caller, wired the way every real one is.
 *
 * A real component rather than a `render` callback holding hooks: a callback is not a component,
 * so React's rules do not apply to it and the hooks would be a bug that happens to work.
 */
function Picker({
  options,
  label,
  fieldLabel,
  placeholder,
  emptyMessage,
}: {
  readonly options: readonly ListboxOption[];
  readonly label: string;
  readonly fieldLabel: string;
  readonly placeholder: string;
  readonly emptyMessage: string;
}): ReactNode {
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);

  const needle = query.trim().toLowerCase();
  const shown =
    needle.length === 0
      ? options
      : options.filter((option) => option.label.toLowerCase().includes(needle));

  const listbox = useListbox(shown, (option) => {
    setChosen(option.label);
    setQuery('');
  });

  return (
    <div className="w-[360px]">
      <Blueprint className="overflow-hidden bg-background">
        <Input
          tone="plain"
          aria-label={fieldLabel}
          role="combobox"
          aria-expanded
          aria-controls={listbox.id}
          aria-activedescendant={listbox.activeOptionId}
          placeholder={placeholder}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          onKeyDown={listbox.onKeyDown}
        />
        <Listbox
          label={label}
          options={shown}
          controller={listbox}
          emptyMessage={emptyMessage}
          className="max-h-[280px] overflow-y-auto border-t border-divider"
        />
      </Blueprint>

      <p className="mt-3 text-sm text-muted">
        {chosen === null ? 'Nothing chosen yet.' : `Chose ${chosen}.`}
      </p>
    </div>
  );
}

const BLOCKS: readonly ListboxOption[] = [
  { id: 'paragraph', label: 'Text', hint: 'Plain paragraph', icon: Type },
  { id: 'heading-1', label: 'Heading 1', hint: 'Section title', icon: Heading1 },
  { id: 'bullet-list', label: 'Bulleted list', hint: 'An unordered list', icon: List },
  { id: 'blockquote', label: 'Quote', hint: 'Set text apart', icon: Quote },
  { id: 'table', label: 'Table', hint: 'Three columns', icon: TableIcon },
];

/** The block inserter: a short list, every entry with an icon and a few words of context. */
export const Blocks: Story = {
  render: () => (
    <Picker
      options={BLOCKS}
      label="Blocks"
      fieldLabel="Filter blocks"
      placeholder="Filter blocks"
      emptyMessage="No block matches that."
    />
  ),
};

/** The command palette: two kinds of result under headings, in one keyboard sequence. */
export const Grouped: Story = {
  render: () => (
    <Picker
      options={[
        { id: 'new-note', label: 'New note', hint: 'Create', icon: Plus, group: 'Commands' },
        { id: 'search', label: 'Search everything', icon: Search, group: 'Commands' },
        { id: 'plan', label: 'The quarterly plan', icon: FileText, group: 'Items' },
        { id: 'ledger', label: 'Ledger review', icon: FileText, group: 'Items' },
      ]}
      label="Commands and items"
      fieldLabel="Search or run a command"
      placeholder="Search or run a command"
      emptyMessage="Nothing matches that."
    />
  ),
};

/**
 * Nothing matches.
 *
 * A sentence rather than an empty box: a list that silently empties leaves somebody wondering
 * whether it is still loading. Type anything into the field above to see it.
 */
export const Empty: Story = {
  render: () => (
    <Picker
      options={[]}
      label="Blocks"
      fieldLabel="Filter blocks"
      placeholder="Filter blocks"
      emptyMessage="No block matches that."
    />
  ),
};
