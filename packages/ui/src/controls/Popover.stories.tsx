import { useState } from 'react';
import { type Meta, type StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';

import { Button } from './Button';
import { Input } from './Input';
import { Dialog } from './Dialog';
import { Popover } from './Popover';

/** A small non-modal panel of controls beside its trigger, and a bottom sheet on a phone. */
const meta = {
  title: 'Controls/Popover',
  component: Popover,
  args: {
    label: 'Filter',
    trigger: (trigger) => (
      <Button variant="secondary" {...trigger}>
        Filter
      </Button>
    ),
    children: ({ close }) => (
      <>
        <Input aria-label="Contains" placeholder="Contains" />
        <Button onClick={close}>Apply</Button>
      </>
    ),
  },
} satisfies Meta<typeof Popover>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Closed: Story = {};

export const Open: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: 'Filter' }));
    await expect(canvas.getByRole('dialog', { name: 'Filter' })).toBeVisible();
  },
};

export const InsideModal: Story = {
  render: (args) => (
    <Dialog open title="Item settings" onClose={() => undefined}>
      <Popover {...args} />
    </Dialog>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    const trigger = canvas.getByRole('button', { name: 'Filter' });
    await userEvent.click(trigger);
    const field = canvas.getByRole('textbox', { name: 'Contains' });
    await expect(field).toHaveFocus();
    await userEvent.type(field, 'Reading');
    await expect(field).toHaveValue('Reading');
    await userEvent.keyboard('{Escape}');
    await expect(trigger).toHaveFocus();
    await expect(canvas.getByRole('dialog', { name: 'Item settings' })).toBeVisible();
    await userEvent.click(trigger);
  },
};

/** A field that commits on blur keeps what was typed when the panel is dismissed by a press outside. */
export const KeepsTypedTextOnOutsidePress: Story = {
  render: (args) => {
    const [saved, setSaved] = useState('none');
    return (
      <>
        <Popover {...args} label="Name">
          <Input
            aria-label="Name"
            onBlur={(event) => {
              setSaved(event.currentTarget.value);
            }}
          />
        </Popover>
        <p data-testid="saved">{saved}</p>
        <button type="button">Elsewhere</button>
      </>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: 'Filter' }));
    await userEvent.type(canvas.getByRole('textbox', { name: 'Name' }), 'Q3 plan');
    await userEvent.click(canvas.getByRole('button', { name: 'Elsewhere' }));
    await expect(canvas.queryByRole('dialog')).toBeNull();
    await expect(canvas.getByTestId('saved')).toHaveTextContent('Q3 plan');
  },
};
