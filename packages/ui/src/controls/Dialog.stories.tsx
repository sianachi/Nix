import { type Meta, type StoryObj } from '@storybook/react-vite';
import { useRef, useState, type ReactNode } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { Text } from '../primitives/Text';
import { Button } from './Button';
import { Dialog, type DialogProps } from './Dialog';
import { Field } from './Field';
import { Input } from './Input';

/**
 * The modal, open, and the whole open-and-close round trip.
 *
 * These stories run in a real browser, which matters more here than anywhere else in the library:
 * the top layer, the `::backdrop`, the inert page behind it and the focus trap are the platform's,
 * and jsdom has none of them. What the unit tests can only assert about intent - that the dialog is
 * opened *modally* - is visibly true here.
 */
const meta = {
  title: 'Controls/Dialog',
  component: Dialog,
  args: {
    open: true,
    onClose: fn(),
    title: 'Delete this document?',
    children: (
      <Text variant="bodySmall">
        The document and its version history are removed for everyone in the workspace. This cannot
        be undone.
      </Text>
    ),
  },
  argTypes: {
    open: { control: 'boolean' },
  },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Dialog>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Title, body, close control. No actions: some dialogs only have something to say. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole('dialog', { name: 'Delete this document?' }),
    ).toBeInTheDocument();
  },
};

/** The usual shape: a decision, with the primary action last. */
export const WithActions: Story = {
  args: {
    actions: (
      <>
        <Button variant="secondary">Keep document</Button>
        <Button>Delete document</Button>
      </>
    ),
  },
};

/** Closed. The element stays mounted, so the invoker keeps its place in the tab order. */
export const Closed: Story = {
  args: { open: false },
};

/** A long body scrolls inside the frame; the registration marks are never clipped. */
export const LongBody: Story = {
  args: {
    title: 'Version retention',
    children: (
      <div className="flex flex-col gap-3">
        {Array.from({ length: 12 }, (_, index) => (
          <Text key={index} variant="bodySmall">
            Versions are kept for thirty days and then coalesced into a single snapshot. A document
            restored from a coalesced snapshot keeps its links but loses its intermediate history.
          </Text>
        ))}
      </div>
    ),
    actions: <Button>Understood</Button>,
  },
};

/**
 * The round trip a user actually performs: open from a button, close, and land back on the button
 * that opened it. Focus returning to the invoker is the difference between carrying on and
 * hunting for your place from the top of the page.
 */
function DialogHarness(props: Omit<DialogProps, 'open' | 'onClose'>): ReactNode {
  const [open, setOpen] = useState(false);

  return (
    <div className="p-8">
      <Button
        onClick={() => {
          setOpen(true);
        }}
      >
        Delete document
      </Button>
      <Dialog
        {...props}
        open={open}
        onClose={() => {
          setOpen(false);
        }}
      />
    </div>
  );
}

export const OpensAndReturnsFocus: Story = {
  render: (args) => <DialogHarness title={args.title}>{args.children}</DialogHarness>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const invoker = canvas.getByRole('button', { name: 'Delete document' });

    await userEvent.click(invoker);
    const dialog = await canvas.findByRole('dialog', { name: 'Delete this document?' });
    await expect(dialog).toHaveFocus();

    await userEvent.click(canvas.getByRole('button', { name: 'Close' }));
    await expect(invoker).toHaveFocus();
    // A closed <dialog> is display:none, so it leaves the accessibility tree entirely rather than
    // lingering as a hidden landmark.
    await expect(canvas.queryByRole('dialog')).toBeNull();
  },
};

/**
 * Modal, which is the assertion behind "focus is trapped": `:modal` matches exactly when the
 * browser has put the element in the top layer and made the rest of the document inert, and inert
 * is what confines Tab. It cannot be shown by tabbing here - a play function's Tab is synthetic,
 * and the simulated focus order is computed from the whole document precisely because it does not
 * know about the top layer - so the state itself is what gets checked.
 */
export const OpenedAsModal: Story = {
  render: (args) => <DialogHarness title={args.title}>{args.children}</DialogHarness>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(canvas.getByRole('button', { name: 'Delete document' }));

    await expect(canvas.getByRole('dialog').matches(':modal')).toBe(true);
  },
};

/**
 * Escape, as the platform reports it. A synthetic key press cannot trigger a browser's default
 * action, so the story dispatches the `cancel` event that a real Escape produces - which is the
 * event this component listens for, and the reason it does not carry a keydown handler of its own.
 */
export const ClosesOnEscape: Story = {
  render: (args) => <DialogHarness title={args.title}>{args.children}</DialogHarness>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(canvas.getByRole('button', { name: 'Delete document' }));
    const dialog = canvas.getByRole('dialog');
    await expect(dialog).toBeVisible();

    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));

    // Dispatched rather than clicked, so React has not already flushed for us.
    await waitFor(async () => {
      await expect(canvas.queryByRole('dialog')).toBeNull();
    });
  },
};

/** The backdrop dismisses it; a click on the content does not. */
export const ClosesOnBackdropClick: Story = {
  render: (args) => (
    <DialogHarness
      title={args.title}
      actions={
        <>
          <Button variant="secondary">Keep document</Button>
          <Button>Delete document permanently</Button>
        </>
      }
    >
      {args.children}
    </DialogHarness>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(canvas.getByRole('button', { name: 'Delete document' }));
    const dialog = canvas.getByRole('dialog');

    await userEvent.click(canvas.getByRole('button', { name: 'Keep document' }));
    await expect(dialog).toBeVisible();

    // Dispatched at the element itself, which is where the browser sends a backdrop click.
    await userEvent.pointer([{ target: dialog, keys: '[MouseLeft]' }]);
    await expect(canvas.queryByRole('dialog')).toBeNull();
  },
};

/**
 * A dialog whose whole purpose is one field puts the cursor in it. The ref is how a caller says
 * so - React never renders an `autofocus` attribute, and the content here mounts long before the
 * dialog opens.
 */
function RenameHarness(): ReactNode {
  const [open, setOpen] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  return (
    <div className="p-8">
      <Button
        onClick={() => {
          setOpen(true);
        }}
      >
        Rename
      </Button>
      <Dialog
        open={open}
        title="Rename document"
        initialFocus={nameRef}
        onClose={() => {
          setOpen(false);
        }}
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button>Rename</Button>
          </>
        }
      >
        <Field label="New name">
          {(control) => <Input {...control} ref={nameRef} defaultValue="Onboarding guide" />}
        </Field>
      </Dialog>
    </div>
  );
}

export const WithInitialFocus: Story = {
  render: () => <RenameHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(canvas.getByRole('button', { name: 'Rename' }));

    await expect(canvas.getByRole('textbox', { name: 'New name' })).toHaveFocus();
  },
};
