import { type Meta, type StoryObj } from '@storybook/react-vite';
import { Columns2, Link, Star, Trash2 } from 'lucide-react';
import { expect, fireEvent, fn, userEvent, waitFor, within } from 'storybook/test';

import { focusRing } from '../primitives/interaction';
import { ContextMenu } from './ContextMenu';
import { type MenuEntry } from './Menu';

/**
 * The secondary-click menu. It opens the same panel `<Menu>` does, at the pointer rather than
 * under a trigger, so its keyboard model and device concessions are `<Menu>`'s own.
 */
const ITEMS: MenuEntry[] = [
  { kind: 'action', label: 'Open beside', icon: Columns2, shortcut: 'Alt+Enter', onSelect: fn() },
  { kind: 'action', label: 'Bookmark', icon: Star, onSelect: fn() },
  { kind: 'action', label: 'Copy link', icon: Link, onSelect: fn() },
  { kind: 'separator' },
  { kind: 'action', label: 'Move to trash', icon: Trash2, destructive: true, onSelect: fn() },
];

const meta = {
  title: 'Controls/ContextMenu',
  component: ContextMenu,
  args: {
    label: 'Page actions',
    items: ITEMS,
    children: (target) => (
      <div {...target} className="w-64 border border-divider p-3 text-sm select-none">
        <button type="button" className={`w-full text-left ${focusRing}`}>
          Quarterly plan
        </button>
      </div>
    ),
  },
  parameters: { layout: 'padded' },
} satisfies Meta<typeof ContextMenu>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Closed: the row looks like any other until someone asks it for its actions. */
export const Default: Story = {};

/** Opened by a secondary click, focus on the first action and shortcuts beside their labels. */
export const Open: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await fireEvent.contextMenu(canvas.getByRole('button', { name: 'Quarterly plan' }), {
      clientX: 80,
      clientY: 40,
    });
    // The panel is portalled to the document body, outside the story's own canvas.
    await expect(
      within(document.body).getByRole('menuitem', { name: 'Open beside' }),
    ).toHaveFocus();
  },
};

/** Escape closes it and returns focus to the row the keyboard was on. */
export const EscapeReturnsFocus: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const row = canvas.getByRole('button', { name: 'Quarterly plan' });
    row.focus();
    await fireEvent.contextMenu(row);
    await userEvent.keyboard('{Escape}');
    await expect(within(document.body).queryByRole('menu')).not.toBeInTheDocument();
    // Handed back on the next frame, once the choice has had its effect on the page.
    await waitFor(() => expect(row).toHaveFocus());
  },
};
