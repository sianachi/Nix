import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState, type ReactNode } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { Button } from './Button';
import { Dialog } from './Dialog';
import { Input } from './Input';

/**
 * jsdom implements `<dialog>` as far as its `open` attribute and stops: `showModal` and `close` do
 * not exist there, and neither does the top layer, the backdrop, nor the Escape-to-`cancel`
 * translation the browser performs. The shim below supplies exactly those two methods, so the
 * tests can exercise this component's own contract - what it does when the platform reports a
 * cancel, where it puts focus, what it asks the caller to do - without pretending to have tested
 * the parts of the modal that only a real browser has. Those belong to the stories, which run in
 * one.
 */
beforeAll(() => {
  Object.assign(HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) {
      this.open = true;
    },
    close(this: HTMLDialogElement) {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    },
  });
});

afterAll(() => {
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
});

/** Escape, as the platform reports it to a `<dialog>`: a cancellable `cancel` event. */
function pressEscape(dialog: HTMLElement): void {
  dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
}

/** A click on the backdrop: pressed and released on the element itself, outside its content. */
async function clickBackdrop(dialog: HTMLElement): Promise<void> {
  const user = userEvent.setup();
  await user.pointer([{ target: dialog, keys: '[MouseLeft]' }]);
}

function OpenableDialog({ children }: { children?: ReactNode }): ReactNode {
  const [open, setOpen] = useState(false);

  return (
    <>
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
        onClose={() => {
          setOpen(false);
        }}
      >
        {children ?? <p>Pick a new name.</p>}
      </Dialog>
    </>
  );
}

describe('Dialog', () => {
  it('shows nothing until it is told to open', () => {
    render(
      <Dialog open={false} title="Rename document" onClose={vi.fn()}>
        <p>Pick a new name.</p>
      </Dialog>,
    );

    expect(screen.getByRole('dialog', { hidden: true })).not.toHaveAttribute('open');
  });

  it('takes its accessible name from its title', () => {
    render(
      <Dialog open title="Rename document" onClose={vi.fn()}>
        <p>Pick a new name.</p>
      </Dialog>,
    );

    expect(screen.getByRole('dialog', { name: 'Rename document' })).toBeInTheDocument();
  });

  it('opens modally, which is what makes the platform trap focus behind it', () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');

    render(
      <Dialog open title="Rename document" onClose={vi.fn()}>
        <p>Pick a new name.</p>
      </Dialog>,
    );

    // The focus trap is not this component's code and should not be: show() would draw the same
    // box and leave the whole page behind it tabbable. Modality is what does the trapping, so
    // choosing showModal is the assertion.
    expect(showModal).toHaveBeenCalledTimes(1);
  });

  it('moves focus into the dialog on open', async () => {
    const user = userEvent.setup();
    render(<OpenableDialog />);

    await user.click(screen.getByRole('button', { name: 'Rename' }));

    // The dialog itself rather than the close control, so a screen reader hears the name and the
    // body before the actions.
    expect(screen.getByRole('dialog')).toHaveFocus();
  });

  it('lands focus on the element the caller nominated instead of on itself', async () => {
    const user = userEvent.setup();

    function RenameDialog(): ReactNode {
      const [open, setOpen] = useState(false);
      const nameRef = useRef<HTMLInputElement>(null);

      return (
        <>
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
            onClose={() => {
              setOpen(false);
            }}
            initialFocus={nameRef}
          >
            <Input ref={nameRef} aria-label="New name" />
          </Dialog>
        </>
      );
    }

    render(<RenameDialog />);
    await user.click(screen.getByRole('button', { name: 'Rename' }));

    expect(screen.getByRole('textbox', { name: 'New name' })).toHaveFocus();
  });

  it('returns focus to whatever opened it', async () => {
    const user = userEvent.setup();
    render(<OpenableDialog />);

    const invoker = screen.getByRole('button', { name: 'Rename' });
    await user.click(invoker);
    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(invoker).toHaveFocus();
  });

  it('returns focus even when the caller unmounts it instead of closing it', async () => {
    const user = userEvent.setup();

    function UnmountingDialog(): ReactNode {
      const [open, setOpen] = useState(false);

      return (
        <>
          <Button
            onClick={() => {
              setOpen(true);
            }}
          >
            Rename
          </Button>
          {open ? (
            <Dialog
              open
              title="Rename document"
              onClose={() => {
                setOpen(false);
              }}
            >
              <p>Pick a new name.</p>
            </Dialog>
          ) : null}
        </>
      );
    }

    render(<UnmountingDialog />);

    const invoker = screen.getByRole('button', { name: 'Rename' });
    await user.click(invoker);
    await user.click(screen.getByRole('button', { name: 'Close' }));

    // Focus falling to the body would send the next Tab to the top of the page.
    expect(invoker).toHaveFocus();
  });

  it('asks the caller to close when the platform reports Escape', () => {
    const onClose = vi.fn();
    render(
      <Dialog open title="Rename document" onClose={onClose}>
        <p>Pick a new name.</p>
      </Dialog>,
    );

    pressEscape(screen.getByRole('dialog'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not let the element close itself while the caller still says open', () => {
    const onClose = vi.fn();
    render(
      <Dialog open title="Rename document" onClose={onClose}>
        <p>Pick a new name.</p>
      </Dialog>,
    );

    const dialog = screen.getByRole('dialog');
    pressEscape(dialog);

    // Open is the caller's flag. A dialog that closed itself would leave the DOM and the prop
    // disagreeing, and would take the choice to refuse away from a form with unsaved work.
    expect(dialog).toHaveAttribute('open');
  });

  it('asks the caller to close when the backdrop is clicked', async () => {
    const onClose = vi.fn();
    render(
      <Dialog open title="Rename document" onClose={onClose}>
        <p>Pick a new name.</p>
      </Dialog>,
    );

    await clickBackdrop(screen.getByRole('dialog'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays open when the click lands on the content instead', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Dialog open title="Rename document" onClose={onClose}>
        <p>Pick a new name.</p>
      </Dialog>,
    );

    await user.click(screen.getByText('Pick a new name.'));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('stays open when a selection drag starts inside and ends on the backdrop', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Dialog open title="Rename document" onClose={onClose}>
        <p>Pick a new name.</p>
      </Dialog>,
    );

    const dialog = screen.getByRole('dialog');
    await user.pointer([
      { target: screen.getByText('Pick a new name.'), keys: '[MouseLeft>]' },
      { target: dialog, keys: '[/MouseLeft]' },
    ]);

    expect(onClose).not.toHaveBeenCalled();
  });

  it('offers a visible way out, because Escape and the backdrop are not', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Dialog open title="Rename document" onClose={onClose} closeLabel="Dismiss">
        <p>Pick a new name.</p>
      </Dialog>,
    );

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders the actions it is given', () => {
    render(
      <Dialog
        open
        title="Rename document"
        onClose={vi.fn()}
        actions={
          <>
            <Button variant="secondary">Cancel</Button>
            <Button>Rename</Button>
          </>
        }
      >
        <p>Pick a new name.</p>
      </Dialog>,
    );

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rename' })).toBeInTheDocument();
  });

  it('starts a heading outline of its own', () => {
    render(
      <Dialog open title="Rename document" onClose={vi.fn()}>
        <p>Pick a new name.</p>
      </Dialog>,
    );

    expect(screen.getByRole('heading', { level: 2, name: 'Rename document' })).toBeInTheDocument();
  });

  it('leaves the user agent free to centre it', () => {
    render(
      <Dialog open title="Properties" onClose={() => undefined}>
        Body
      </Dialog>,
    );

    // A modal <dialog> is centred by the user agent through `position: fixed; inset: 0;
    // margin: auto`. Any `position` of our own overrides the fixed and the margin then has
    // nothing to centre within - which is exactly what `relative` on the shared frame used to do,
    // for as long as the frame needed it to anchor its corner marks.
    const dialog = document.querySelector('dialog');

    expect(dialog?.className).toContain('m-auto');
    expect(dialog?.className).not.toMatch(/\b(relative|absolute|fixed|sticky)\b/);
  });
});
