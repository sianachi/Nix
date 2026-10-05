import { type Meta, type StoryObj } from '@storybook/react-vite';
import { CreditCard, Settings, Shield, Users } from 'lucide-react';
import { expect, userEvent, within } from 'storybook/test';

import { Nav, type NavItem } from './Nav';

/**
 * Both orientations, with and without the current item, with and without glyphs.
 *
 * The current item is the state worth looking at in every one of these: it is drawn with an accent
 * rule and accent text, and it carries `aria-current="page"` - the colour is the sighted half of a
 * fact that has to reach everybody.
 */
const SETTINGS: NavItem[] = [
  { href: '/settings/general', label: 'General' },
  { href: '/settings/members', label: 'Members' },
  { href: '/settings/permissions', label: 'Permissions' },
  { href: '/settings/billing', label: 'Billing' },
];

const SETTINGS_WITH_ICONS: NavItem[] = [
  { href: '/settings/general', label: 'General', icon: Settings },
  { href: '/settings/members', label: 'Members', icon: Users },
  { href: '/settings/permissions', label: 'Permissions', icon: Shield },
  { href: '/settings/billing', label: 'Billing', icon: CreditCard },
];

const meta = {
  title: 'Controls/Nav',
  component: Nav,
  args: {
    label: 'Workspace settings',
    items: SETTINGS,
    currentHref: '/settings/members',
  },
  argTypes: {
    orientation: { control: 'inline-radio', options: ['vertical', 'horizontal'] },
    currentHref: {
      control: 'inline-radio',
      options: [undefined, ...SETTINGS.map((item) => item.href)],
    },
  },
  parameters: { layout: 'padded' },
} satisfies Meta<typeof Nav>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The settings rail: a column against a hairline, one segment of it in accent. */
export const Vertical: Story = {
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('link', { name: 'Members' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  },
};

/** In-page section navigation: the same set, read across. */
export const Horizontal: Story = {
  args: { orientation: 'horizontal', label: 'Document sections' },
};

/** A destination the nav does not list - nothing is marked, and nothing pretends to be. */
export const NoCurrentItem: Story = {
  args: { currentHref: '/documents' },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).queryByRole('link', { current: 'page' }),
    ).not.toBeInTheDocument();
  },
};

/** Glyphs beside the labels. Decorative: the label is already the accessible name. */
export const WithIcons: Story = {
  args: { items: SETTINGS_WITH_ICONS },
};

export const HorizontalWithIcons: Story = {
  args: { items: SETTINGS_WITH_ICONS, orientation: 'horizontal', label: 'Document sections' },
};

/** Hover on an item that is not the current one: an ink wash, never an accent one. */
export const ItemHover: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.hover(within(canvasElement).getByRole('link', { name: 'Billing' }));
  },
};

/** Keyboard focus: the 2px accent ring, offset by 2px, on a real link. */
export const ItemFocusVisible: Story = {
  play: async ({ canvasElement }) => {
    const link = within(canvasElement).getByRole('link', { name: 'General' });
    await userEvent.tab();
    await expect(link).toHaveFocus();
  },
};

/**
 * The consumer's own link component. This stands in for react-router's `<Link to>`; the rename
 * from `href` to `to` is exactly why the seam is a render prop and not an `as` element.
 */
export const WithConsumerLinkComponent: Story = {
  args: {
    renderLink: ({ href, children, ...rest }) => (
      <a data-router-to={href} href={href} {...rest}>
        {children}
      </a>
    ),
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('link', { name: 'Members' })).toHaveAttribute(
      'data-router-to',
      '/settings/members',
    );
  },
};

/**
 * Both orientations on ink. The current item's rule and its text are the same
 * role, so the mark crosses the ramp in one piece; the accent-700 the rule used
 * to name reads 2.7:1 here, under the 3:1 a state indicator owes.
 */
export const DarkGround: Story = {
  args: { items: SETTINGS_WITH_ICONS },
  globals: { ground: 'dark' },
  render: (args) => (
    <div className="flex flex-col gap-8">
      <Nav {...args} orientation="horizontal" label="Document sections" />
      <Nav {...args} orientation="vertical" label="Workspace settings" />
    </div>
  ),
};

/** Both orientations side by side, so the one current-item treatment reads as one idea. */
export const BothOrientations: Story = {
  render: (args) => (
    <div className="flex flex-col gap-8">
      <Nav {...args} orientation="horizontal" label="Document sections" />
      <Nav {...args} orientation="vertical" label="Workspace settings" />
    </div>
  ),
};
