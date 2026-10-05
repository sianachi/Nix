import { render, screen } from '@testing-library/react';
import { Settings, Users } from 'lucide-react';
import { describe, expect, it } from 'vitest';

import { Nav, type NavItem } from './Nav';

const ITEMS: NavItem[] = [
  { href: '/settings/general', label: 'General' },
  { href: '/settings/members', label: 'Members' },
  { href: '/settings/billing', label: 'Billing' },
];

describe('Nav', () => {
  it('is a navigation landmark with the name it was given', () => {
    render(<Nav label="Workspace settings" items={ITEMS} />);

    expect(screen.getByRole('navigation', { name: 'Workspace settings' })).toBeInTheDocument();
  });

  it('renders every item as a real link to its destination', () => {
    render(<Nav label="Workspace settings" items={ITEMS} />);

    expect(screen.getAllByRole('link')).toHaveLength(3);
    expect(screen.getByRole('link', { name: 'Members' })).toHaveAttribute(
      'href',
      '/settings/members',
    );
  });

  it('marks the item matching the current URL, and only that one', () => {
    render(<Nav label="Workspace settings" items={ITEMS} currentHref="/settings/members" />);

    expect(screen.getByRole('link', { name: 'Members' })).toHaveAttribute('aria-current', 'page');

    for (const name of ['General', 'Billing']) {
      // Absent rather than aria-current="false": every other item is simply not where you are.
      expect(screen.getByRole('link', { name })).not.toHaveAttribute('aria-current');
    }
  });

  it('marks nothing when the current URL is not in the list', () => {
    render(<Nav label="Workspace settings" items={ITEMS} currentHref="/documents" />);

    expect(screen.queryByRole('link', { current: 'page' })).not.toBeInTheDocument();
  });

  it('hands the link off to the consumer so a router can supply its own', () => {
    render(
      <Nav
        label="Workspace settings"
        items={ITEMS}
        currentHref="/settings/general"
        // Stands in for react-router's <Link to>: the rename is the reason this is a render prop
        // rather than an `as` element.
        renderLink={({ href, children, ...rest }) => (
          <a data-to={href} href={href} {...rest}>
            {children}
          </a>
        )}
      />,
    );

    const link = screen.getByRole('link', { name: 'General' });
    expect(link).toHaveAttribute('data-to', '/settings/general');
    // The marking survives the swap - it is the component's contract, not the default anchor's.
    expect(link).toHaveAttribute('aria-current', 'page');
  });

  it('leaves an item icon out of the accessible name', () => {
    render(
      <Nav
        label="Workspace settings"
        items={[
          { href: '/settings/general', label: 'General', icon: Settings },
          { href: '/settings/members', label: 'Members', icon: Users },
        ]}
      />,
    );

    // Exactly the label: a named glyph beside its own label makes the item announce twice.
    expect(screen.getByRole('link', { name: 'General' })).toBeInTheDocument();
  });

  it('draws the current item with the accent role that carries body-size text', () => {
    render(<Nav label="Workspace settings" items={ITEMS} currentHref="/settings/billing" />);

    const className = screen.getByRole('link', { name: 'Billing' }).className;
    // Rule and text are the same role, so the mark cannot half-move when the ground does.
    expect(className).toContain('text-accent-text');
    expect(className).toContain('border-accent-text');
  });

  it('lays the list out along the axis it was asked for', () => {
    const { container: vertical } = render(<Nav label="Settings" items={ITEMS} />);
    const { container: horizontal } = render(
      <Nav label="Sections" items={ITEMS} orientation="horizontal" />,
    );

    expect(vertical.querySelector('ul')?.className).toContain('flex-col');
    expect(horizontal.querySelector('ul')?.className).toContain('flex-row');
  });

  it('carries the shared focus ring rather than a local one', () => {
    render(<Nav label="Workspace settings" items={ITEMS} />);

    expect(screen.getByRole('link', { name: 'General' }).className).toContain(
      'focus-visible:outline-accent',
    );
  });

  it('accepts a layout class on the landmark without disturbing the list', () => {
    render(<Nav label="Workspace settings" items={ITEMS} className="mt-4" />);

    expect(screen.getByRole('navigation', { name: 'Workspace settings' }).className).toBe('mt-4');
  });
});
