import { type Meta, type StoryObj } from '@storybook/react-vite';

import { Field } from './Field';
import { Select } from './Select';

/**
 * One choice from a list, on the platform's own `<select>`.
 *
 * Native rather than built: typeahead, arrow keys, home and end, and the system picker on a phone
 * all come free and correct, which a custom listbox rarely manages in every combination.
 */
const meta = {
  title: 'Controls/Select',
  component: Select,
  args: {
    'aria-label': 'Property type',
    children: (
      <>
        <option value="text">Text</option>
        <option value="number">Number</option>
        <option value="select">Select</option>
        <option value="date">Date</option>
        <option value="timestamp">Date and time</option>
      </>
    ),
  },
} satisfies Meta<typeof Select>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The ordinary case. Stands the same height as an `<Input>` beside it. */
export const Default: Story = {};

/** Nothing chosen yet, with the empty option saying so rather than showing the first value. */
export const Unchosen: Story = {
  args: {
    defaultValue: '',
    children: (
      <>
        <option value="">Choose a property</option>
        <option value="status">Status</option>
        <option value="owner">Owner</option>
      </>
    ),
  },
};

/** Refused by the server, or empty when it may not be. */
export const Invalid: Story = {
  args: { 'aria-invalid': true },
};

export const Disabled: Story = {
  args: { disabled: true },
};

/** Wrapped in a `<Field>`, which is how every form in the product uses it. */
export const InAField: Story = {
  render: (args) => (
    <Field label="Type" hint="What kind of value this property holds.">
      {(control) => <Select {...control} {...args} />}
    </Field>
  ),
};
