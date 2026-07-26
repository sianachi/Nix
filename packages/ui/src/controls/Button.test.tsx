import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Plus } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';

import { Icon } from '../primitives/Icon';
import { Button } from './Button';

describe('Button', () => {
  it('exposes its label as the accessible name of a button', () => {
    render(<Button>Publish</Button>);

    expect(screen.getByRole('button', { name: 'Publish' })).toBeInTheDocument();
  });

  it('defaults to type button so it cannot submit a surrounding form by accident', () => {
    render(<Button>Publish</Button>);

    expect(screen.getByRole('button', { name: 'Publish' })).toHaveAttribute('type', 'button');
  });

  it('activates on Enter for a keyboard user', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Publish</Button>);

    await user.tab();
    expect(screen.getByRole('button', { name: 'Publish' })).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('activates on Space for a keyboard user', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Publish</Button>);

    await user.tab();
    await user.keyboard(' ');

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('reports itself as disabled and ignores clicks when disabled', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Publish
      </Button>,
    );

    const button = screen.getByRole('button', { name: 'Publish' });
    expect(button).toBeDisabled();

    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('drops out of the tab order when disabled', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Button disabled>Publish</Button>
        <Button>Discard</Button>
      </>,
    );

    await user.tab();

    expect(screen.getByRole('button', { name: 'Discard' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Publish' })).not.toHaveFocus();
  });

  it('names an icon-only button from its aria-label', () => {
    render(
      <Button variant="icon" aria-label="Add block">
        <Icon icon={Plus} />
      </Button>,
    );

    expect(screen.getByRole('button', { name: 'Add block' })).toBeInTheDocument();
  });

  it('keeps the registration marks on the primary button and nowhere else', () => {
    const { container: primary } = render(<Button variant="primary">Publish</Button>);
    expect(primary.querySelectorAll('[aria-hidden="true"]')).toHaveLength(4);

    const { container: secondary } = render(<Button variant="secondary">Discard</Button>);
    expect(secondary.querySelectorAll('[aria-hidden="true"]')).toHaveLength(0);
  });

  it('fills the primary button from the accent ramp step that carries text', () => {
    render(<Button variant="primary">Publish</Button>);

    const button = screen.getByRole('button', { name: 'Publish' });
    expect(button.className).toContain('bg-accent-700');
    expect(button.className).not.toMatch(/(^|\s)bg-accent(\s|$)/);
  });

  it('gives each variant its own frame color rather than the primitive default', () => {
    render(
      <>
        <Button variant="primary">Publish</Button>
        <Button variant="secondary">Discard</Button>
        <Button variant="ghost">Cancel</Button>
      </>,
    );

    const primary = screen.getByRole('button', { name: 'Publish' }).className;
    expect(primary).toContain('border-accent-700');
    expect(primary).not.toContain('border-divider');

    expect(screen.getByRole('button', { name: 'Discard' }).className).toContain('border-divider');
    expect(screen.getByRole('button', { name: 'Cancel' }).className).toContain(
      'border-transparent',
    );
  });

  it('is square-cornered in every variant', () => {
    for (const variant of ['primary', 'secondary', 'ghost'] as const) {
      const { container } = render(<Button variant={variant}>Act</Button>);
      const button = container.querySelector('button');
      expect(button?.className).toContain('rounded-none');
    }
  });

  it('carries the shared focus ring and disabled treatment rather than a local one', () => {
    render(<Button>Publish</Button>);

    const className = screen.getByRole('button', { name: 'Publish' }).className;
    expect(className).toContain('focus-visible:outline-accent');
    expect(className).toContain('focus-visible:outline-offset-2');
    expect(className).toContain('disabled:opacity-45');
  });

  it('lets a caller add a layout class without losing its own', () => {
    render(<Button className="mt-4">Publish</Button>);

    const className = screen.getByRole('button', { name: 'Publish' }).className;
    expect(className).toContain('mt-4');
    expect(className).toContain('bg-accent-700');
  });
});
