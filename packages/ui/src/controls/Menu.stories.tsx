import { type Meta, type StoryObj } from '@storybook/react-vite';
import { Archive, LogOut, Plus, Settings, Trash2 } from 'lucide-react';
import { expect, fn, userEvent, within } from 'storybook/test';

import { focusRing } from '../primitives/interaction';
import { Menu, type MenuEntry } from './Menu';

/**
 * The menu-button pattern, and the two device concessions it makes: the panel flips above the
 * trigger and clamps inside the viewport rather than running off it, and below `sm` it becomes a
 * bottom sheet rather than a positioned box a thumb can barely reach.
 *
 * `WithConsumerLinkComponent` is the shape both migrated call sites use in practice - a mix of
 * link items opened through the caller's router and action items that run a handler - which is
 * why it, rather than the plain-action default, is the story most of the interaction tests read.
 */
const ITEMS: MenuEntry[] = [
  { kind: 'action', label: 'New workspace', icon: Plus, onSelect: fn() },
  { kind: 'action', label: 'Settings', icon: Settings, onSelect: fn() },
  { kind: 'separator' },
  { kind: 'action', label: 'Archive', icon: Archive, onSelect: fn() },
  { kind: 'action', label: 'Delete workspace', icon: Trash2, destructive: true, onSelect: fn() },
];

const meta = {
  title: 'Controls/Menu',
  component: Menu,
  args: {
    label: 'Workspace actions',
    items: ITEMS,
    children: (trigger) => (
      <button {...trigger} className={`border border-divider px-3 py-1.5 text-sm ${focusRing}`}>
        Actions
      </button>
    ),
  },
  parameters: { layout: 'padded' },
} satisfies Meta<typeof Menu>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Closed. A menu ships closed - opening it is the person's decision, not the page's. */
export const Default: Story = {};

/** Opened by a click: the panel, the separator, and the destructive item's bolder weight. */
export const Open: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Actions' }));
    await expect(canvas.getByRole('menu', { name: 'Workspace actions' })).toBeInTheDocument();
    await expect(canvas.getByRole('menuitem', { name: 'Delete workspace' })).toBeInTheDocument();
  },
};

/** ArrowDown from the trigger opens the menu onto its first item. */
export const OpenFromKeyboard: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    canvas.getByRole('button', { name: 'Actions' }).focus();
    await userEvent.keyboard('{ArrowDown}');
    await expect(canvas.getByRole('menuitem', { name: 'New workspace' })).toHaveFocus();
  },
};

/** ArrowUp from the trigger opens onto the last item - the pattern's usual courtesy. */
export const OpenFromKeyboardArrowUp: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    canvas.getByRole('button', { name: 'Actions' }).focus();
    await userEvent.keyboard('{ArrowUp}');
    await expect(canvas.getByRole('menuitem', { name: 'Delete workspace' })).toHaveFocus();
  },
};

/** Arrow keys walk the list; Home and End jump to its ends. */
export const KeyboardNavigation: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    canvas.getByRole('button', { name: 'Actions' }).focus();
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    await expect(canvas.getByRole('menuitem', { name: 'Archive' })).toHaveFocus();
    await userEvent.keyboard('{End}');
    await expect(canvas.getByRole('menuitem', { name: 'Delete workspace' })).toHaveFocus();
    await userEvent.keyboard('{Home}');
    await expect(canvas.getByRole('menuitem', { name: 'New workspace' })).toHaveFocus();
  },
};

/** Escape closes the menu and hands focus straight back to the trigger. */
export const EscapeReturnsFocus: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: 'Actions' });
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{Escape}');
    await expect(canvas.queryByRole('menu')).not.toBeInTheDocument();
    await expect(trigger).toHaveFocus();
  },
};

/** A click outside the trigger and the panel closes it without acting on anything. */
export const ClosesOnOutsideClick: Story = {
  render: (args) => (
    <div>
      <Menu {...args} />
      <p>Outside the menu.</p>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Actions' }));
    await userEvent.click(canvas.getByText('Outside the menu.'));
    await expect(canvas.queryByRole('menu')).not.toBeInTheDocument();
  },
};

/** The consumer's own link component - the seam `Nav.tsx`'s `renderLink` uses for the same reason. */
export const WithConsumerLinkComponent: Story = {
  args: {
    items: [
      {
        kind: 'link',
        label: 'Settings',
        icon: Settings,
        href: '/w/1/settings',
        onSelect: fn(),
      },
      { kind: 'separator' },
      { kind: 'action', label: 'Sign out', icon: LogOut, destructive: true, onSelect: fn() },
    ],
    renderLink: ({ href, children, ...rest }) => (
      <a data-router-to={href} href={href} {...rest}>
        {children}
      </a>
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Actions' }));
    await expect(canvas.getByRole('menuitem', { name: 'Settings' })).toHaveAttribute(
      'data-router-to',
      '/w/1/settings',
    );
  },
};

/**
 * A `content` entry - an account header, here - alongside real items. It draws exactly as given
 * and sits outside arrow-key navigation, the shape the profile menu uses for its identity block
 * and appearance switcher.
 */
export const WithContentEntry: Story = {
  args: {
    items: [
      {
        kind: 'content',
        content: (
          <div className="border-b border-divider px-3 py-2 text-sm">
            <p className="font-semibold">Ada Lovelace</p>
            <p className="text-muted">ada@example.test</p>
          </div>
        ),
      },
      { kind: 'action', label: 'Sign out', icon: LogOut, onSelect: fn() },
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Actions' }));
    await expect(canvas.getByText('Ada Lovelace')).toBeVisible();
    await expect(canvas.getAllByRole('menuitem')).toHaveLength(1);
  },
};

/** Disabled items are skipped by arrow-key navigation and cannot be selected. */
export const WithDisabledItem: Story = {
  args: {
    items: [
      { kind: 'action', label: 'New workspace', icon: Plus, onSelect: fn() },
      { kind: 'action', label: 'Settings', icon: Settings, disabled: true, onSelect: fn() },
      { kind: 'action', label: 'Archive', icon: Archive, onSelect: fn() },
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    canvas.getByRole('button', { name: 'Actions' }).focus();
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{ArrowDown}');
    await expect(canvas.getByRole('menuitem', { name: 'Archive' })).toHaveFocus();
  },
};

/**
 * Below `sm`, the panel drops the anchored position and becomes a full-width bottom sheet, and
 * every item is 44px tall under `pointer-coarse:` - the same `--control-lg` step `Button.tsx`
 * reaches for a touch target.
 */
export const MobileBottomSheet: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Actions' }));
    await expect(canvas.getByRole('menu', { name: 'Workspace actions' })).toBeVisible();
  },
  parameters: { viewport: { defaultViewport: 'mobile1' } },
};

/** The panel on ink: same hairline frame, same shadow, no colour anywhere that does not cross the ramp. */
export const DarkGround: Story = {
  globals: { ground: 'dark' },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Actions' }));
  },
};
