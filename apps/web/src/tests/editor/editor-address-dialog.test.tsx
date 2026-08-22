import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { EditorAddressDialog } from '../../editor/editor-address-dialog';

function ImageDialog(props: {
  readonly onCancel?: () => void;
  readonly onSubmit?: Parameters<typeof EditorAddressDialog>[0]['onSubmit'];
}): ReactNode {
  return (
    <EditorAddressDialog
      kind="image"
      onCancel={props.onCancel ?? (() => undefined)}
      onSubmit={props.onSubmit ?? (() => undefined)}
    />
  );
}

describe('the image insertion form', () => {
  it('starts in the address field and explains both fields', () => {
    render(<ImageDialog />);

    expect(screen.getByRole('dialog', { name: 'Insert image' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Image address' })).toHaveFocus();
    expect(screen.getByText(/complete http or https address/i)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveAccessibleDescription(
      /leave this blank only when the image is decorative/i,
    );
  });

  it('keeps an invalid address in the form and tells the person how to fix it', async () => {
    const user = userEvent.setup();
    const onInsert = vi.fn();
    render(<ImageDialog onSubmit={onInsert} />);

    const address = screen.getByRole('textbox', { name: 'Image address' });
    await user.type(address, '   ');
    await user.click(screen.getByRole('button', { name: 'Insert image' }));

    expect(onInsert).not.toHaveBeenCalled();
    expect(address).toHaveFocus();
    expect(address).toHaveAttribute('aria-invalid', 'true');
    expect(address).toHaveAccessibleDescription('Enter an image address.');
  });

  it.each(['gallery/photo.png', 'data:image/png;base64,eA==', 'javascript:alert(1)'])(
    'refuses an address the browser must not fetch: %s',
    async (value) => {
      const user = userEvent.setup();
      const onInsert = vi.fn();
      render(<ImageDialog onSubmit={onInsert} />);

      const address = screen.getByRole('textbox', { name: 'Image address' });
      await user.type(address, value);
      await user.click(screen.getByRole('button', { name: 'Insert image' }));

      expect(onInsert).not.toHaveBeenCalled();
      expect(address).toHaveValue(value);
      expect(address).toHaveAccessibleDescription(
        'Enter a complete image address that starts with http:// or https://.',
      );
    },
  );

  it('submits a trimmed address and description', async () => {
    const user = userEvent.setup();
    const onInsert = vi.fn();
    render(<ImageDialog onSubmit={onInsert} />);

    await user.type(
      screen.getByRole('textbox', { name: 'Image address' }),
      '  https://images.example.test/quarterly-plan.png  ',
    );
    await user.type(
      screen.getByRole('textbox', { name: 'Description' }),
      '  Quarterly plan on a whiteboard  ',
    );
    await user.click(screen.getByRole('button', { name: 'Insert image' }));

    expect(onInsert).toHaveBeenCalledWith({
      address: 'https://images.example.test/quarterly-plan.png',
      description: 'Quarterly plan on a whiteboard',
    });
  });

  it('accepts a decorative image with an explicit empty description when Enter submits', async () => {
    const user = userEvent.setup();
    const onInsert = vi.fn();
    render(<ImageDialog onSubmit={onInsert} />);

    const address = screen.getByRole('textbox', { name: 'Image address' });
    await user.type(address, 'http://images.example.test/divider.png{Enter}');

    expect(onInsert).toHaveBeenCalledWith({
      address: 'http://images.example.test/divider.png',
      description: '',
    });
  });

  it('clears the error as the address is corrected', async () => {
    const user = userEvent.setup();
    render(<ImageDialog />);

    const address = screen.getByRole('textbox', { name: 'Image address' });
    await user.type(address, 'relative.png');
    await user.click(screen.getByRole('button', { name: 'Insert image' }));
    expect(address).toHaveAttribute('aria-invalid', 'true');

    await user.clear(address);
    await user.type(address, 'https://images.example.test/corrected.png');

    expect(address).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('returns focus to the control that opened it when cancelled', async () => {
    const user = userEvent.setup();

    function Harness(): ReactNode {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setOpen(true);
            }}
          >
            Add an image
          </button>
          {open ? (
            <EditorAddressDialog
              kind="image"
              onCancel={() => {
                setOpen(false);
              }}
              onSubmit={() => undefined}
            />
          ) : null}
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Add an image' });
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: /^Cancel$/ }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

describe('the link form', () => {
  it('names its one field, keeps image-only copy out, and submits a trimmed destination', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<EditorAddressDialog kind="link" onCancel={() => undefined} onSubmit={onSubmit} />);

    expect(screen.getByRole('dialog', { name: 'Add link' })).toBeInTheDocument();
    const address = screen.getByRole('textbox', { name: 'Link address' });
    expect(address).toHaveFocus();
    expect(address).toHaveAccessibleDescription(/where this link should go/i);
    expect(screen.queryByRole('textbox', { name: 'Description' })).not.toBeInTheDocument();

    await user.type(address, '  /roadmap#quarter-three  ');
    await user.click(screen.getByRole('button', { name: 'Add link' }));

    expect(onSubmit).toHaveBeenCalledWith({
      address: '/roadmap#quarter-three',
      description: '',
    });
  });

  it('refuses a blank destination in place', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<EditorAddressDialog kind="link" onCancel={() => undefined} onSubmit={onSubmit} />);

    await user.click(screen.getByRole('button', { name: 'Add link' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Link address' })).toHaveAccessibleDescription(
      'Enter a link address.',
    );
  });

  it.each(['javascript:alert(1)', 'data:text/html,unsafe', 'file:///tmp/plan'])(
    'refuses an address the editor will not store: %s',
    async (value) => {
      const user = userEvent.setup();
      const onSubmit = vi.fn();
      render(<EditorAddressDialog kind="link" onCancel={() => undefined} onSubmit={onSubmit} />);

      const address = screen.getByRole('textbox', { name: 'Link address' });
      await user.type(address, value);
      await user.click(screen.getByRole('button', { name: 'Add link' }));

      expect(onSubmit).not.toHaveBeenCalled();
      expect(address).toHaveValue(value);
      expect(address).toHaveAccessibleDescription(
        'Enter a relative link or an address that uses a supported protocol.',
      );
    },
  );

  it.each([
    '/roadmap',
    'https://example.test/plan',
    'http://example.test/plan',
    'mailto:editor@example.test',
  ])('submits a supported destination: %s', async (value) => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<EditorAddressDialog kind="link" onCancel={() => undefined} onSubmit={onSubmit} />);

    await user.type(screen.getByRole('textbox', { name: 'Link address' }), value);
    await user.click(screen.getByRole('button', { name: 'Add link' }));

    expect(onSubmit).toHaveBeenCalledWith({ address: value, description: '' });
  });
});
