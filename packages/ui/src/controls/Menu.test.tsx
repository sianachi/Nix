import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Settings } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';

import { Menu, type MenuEntry } from './Menu';

/** The trigger every test shares: a plain button with the render prop spread onto it. */
function trigger(name = 'Actions') {
  return (props: Parameters<Parameters<typeof Menu>[0]['children']>[0]) => (
    <button {...props}>{name}</button>
  );
}

const ACTION_ITEMS: MenuEntry[] = [
  { kind: 'action', label: 'New workspace', onSelect: vi.fn() },
  { kind: 'action', label: 'Settings', icon: Settings, onSelect: vi.fn() },
  { kind: 'separator' },
  { kind: 'action', label: 'Delete workspace', destructive: true, onSelect: vi.fn() },
];

describe('Menu', () => {
  it('starts closed, with a trigger that names the menu it opens', () => {
    render(<Menu label="Workspace actions" items={ACTION_ITEMS} children={trigger()} />);

    const button = screen.getByRole('button', { name: 'Actions' });
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens on click, as a menu with the name it was given', async () => {
    const user = userEvent.setup();
    render(<Menu label="Workspace actions" items={ACTION_ITEMS} children={trigger()} />);

    await user.click(screen.getByRole('button', { name: 'Actions' }));

    expect(screen.getByRole('menu', { name: 'Workspace actions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Actions' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('renders a separator between the runs it was given, and nothing either side of it', async () => {
    const user = userEvent.setup();
    render(<Menu label="Workspace actions" items={ACTION_ITEMS} children={trigger()} />);
    await user.click(screen.getByRole('button', { name: 'Actions' }));

    expect(screen.getByRole('separator')).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
  });

  it('marks a destructive item without reaching for a colour the token sheet does not have', async () => {
    const user = userEvent.setup();
    render(<Menu label="Workspace actions" items={ACTION_ITEMS} children={trigger()} />);
    await user.click(screen.getByRole('button', { name: 'Actions' }));

    expect(screen.getByRole('menuitem', { name: 'Delete workspace' })).toHaveClass('font-semibold');
  });

  it('selecting an item closes the menu, runs its handler once, and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const items: MenuEntry[] = [{ kind: 'action', label: 'New workspace', onSelect }];
    render(<Menu label="Workspace actions" items={items} children={trigger()} />);
    const button = screen.getByRole('button', { name: 'Actions' });

    await user.click(button);
    await user.click(screen.getByRole('menuitem', { name: 'New workspace' }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it('ArrowDown on the trigger opens the menu onto its first item', async () => {
    const user = userEvent.setup();
    render(<Menu label="Workspace actions" items={ACTION_ITEMS} children={trigger()} />);

    screen.getByRole('button', { name: 'Actions' }).focus();
    await user.keyboard('{ArrowDown}');

    expect(screen.getByRole('menuitem', { name: 'New workspace' })).toHaveFocus();
  });

  it('ArrowUp on the trigger opens the menu onto its last item', async () => {
    const user = userEvent.setup();
    render(<Menu label="Workspace actions" items={ACTION_ITEMS} children={trigger()} />);

    screen.getByRole('button', { name: 'Actions' }).focus();
    await user.keyboard('{ArrowUp}');

    expect(screen.getByRole('menuitem', { name: 'Delete workspace' })).toHaveFocus();
  });

  it('ArrowDown and ArrowUp move focus between items and wrap at the ends', async () => {
    const user = userEvent.setup();
    render(<Menu label="Workspace actions" items={ACTION_ITEMS} children={trigger()} />);
    screen.getByRole('button', { name: 'Actions' }).focus();
    await user.keyboard('{ArrowDown}');

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Delete workspace' })).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'New workspace' })).toHaveFocus();

    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('menuitem', { name: 'Delete workspace' })).toHaveFocus();
  });

  it('Home and End jump to the first and last item', async () => {
    const user = userEvent.setup();
    render(<Menu label="Workspace actions" items={ACTION_ITEMS} children={trigger()} />);
    screen.getByRole('button', { name: 'Actions' }).focus();
    await user.keyboard('{ArrowDown}');

    await user.keyboard('{End}');
    expect(screen.getByRole('menuitem', { name: 'Delete workspace' })).toHaveFocus();

    await user.keyboard('{Home}');
    expect(screen.getByRole('menuitem', { name: 'New workspace' })).toHaveFocus();
  });

  it('a disabled item is skipped by arrow-key navigation', async () => {
    const user = userEvent.setup();
    const items: MenuEntry[] = [
      { kind: 'action', label: 'New workspace', onSelect: vi.fn() },
      { kind: 'action', label: 'Settings', disabled: true, onSelect: vi.fn() },
      { kind: 'action', label: 'Archive', onSelect: vi.fn() },
    ];
    render(<Menu label="Workspace actions" items={items} children={trigger()} />);
    screen.getByRole('button', { name: 'Actions' }).focus();
    await user.keyboard('{ArrowDown}');

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toHaveFocus();
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toBeDisabled();
  });

  it('Escape closes the menu and hands focus back to the trigger', async () => {
    const user = userEvent.setup();
    render(<Menu label="Workspace actions" items={ACTION_ITEMS} children={trigger()} />);
    const button = screen.getByRole('button', { name: 'Actions' });
    button.focus();
    await user.keyboard('{ArrowDown}');

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it('a click outside the trigger and the panel closes the menu without acting on anything', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const items: MenuEntry[] = [{ kind: 'action', label: 'New workspace', onSelect }];
    render(
      <div>
        <Menu label="Workspace actions" items={items} children={trigger()} />
        <p>Outside</p>
      </div>,
    );

    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await user.click(screen.getByText('Outside'));

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('renders a link item as a real link, through the caller-supplied router link', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const items: MenuEntry[] = [
      { kind: 'link', label: 'Settings', href: '/w/1/settings', onSelect },
    ];
    render(
      <Menu
        label="Account"
        items={items}
        children={trigger()}
        renderLink={({ href, children, ...rest }) => (
          <a data-router-to={href} href={href} {...rest}>
            {children}
          </a>
        )}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Actions' }));
    const link = screen.getByRole('menuitem', { name: 'Settings' });

    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('data-router-to', '/w/1/settings');

    await user.click(link);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('items are 44px tall under a coarse pointer, the same step Button.tsx reaches for a touch target', async () => {
    const user = userEvent.setup();
    render(<Menu label="Workspace actions" items={ACTION_ITEMS} children={trigger()} />);
    await user.click(screen.getByRole('button', { name: 'Actions' }));

    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveClass(
      'pointer-coarse:h-(--control-lg)',
    );
  });

  it('renders a `content` entry as given, outside the roving item order', async () => {
    const user = userEvent.setup();
    const items: MenuEntry[] = [
      { kind: 'content', content: <p>Signed in as Ada</p> },
      { kind: 'action', label: 'Sign out', onSelect: vi.fn() },
    ];
    render(<Menu label="Account" items={items} children={trigger()} />);
    await user.click(screen.getByRole('button', { name: 'Actions' }));

    expect(screen.getByText('Signed in as Ada')).toBeVisible();
    expect(screen.getAllByRole('menuitem')).toHaveLength(1);
  });

  it('a `content` render function can close the menu, for its own plain links', async () => {
    const user = userEvent.setup();
    const items: MenuEntry[] = [
      {
        kind: 'content',
        content: ({ close }) => (
          <a href="/elsewhere" onClick={close}>
            Elsewhere
          </a>
        ),
      },
    ];
    render(<Menu label="Account" items={items} children={trigger()} />);
    await user.click(screen.getByRole('button', { name: 'Actions' }));

    await user.click(screen.getByRole('link', { name: 'Elsewhere' }));

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('Escape closes the menu even from a `content` entry, which has no menuitem of its own', async () => {
    const user = userEvent.setup();
    const items: MenuEntry[] = [{ kind: 'content', content: <input aria-label="Search" /> }];
    render(<Menu label="Account" items={items} children={trigger()} />);
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await user.click(screen.getByRole('textbox', { name: 'Search' }));

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('becomes a full-width bottom sheet below the sm breakpoint', async () => {
    const user = userEvent.setup();
    render(<Menu label="Workspace actions" items={ACTION_ITEMS} children={trigger()} />);
    await user.click(screen.getByRole('button', { name: 'Actions' }));

    expect(screen.getByRole('menu')).toHaveClass('max-sm:w-full', 'max-sm:bottom-0');
  });
});
