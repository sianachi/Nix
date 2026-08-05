import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Tabs, type TabItem } from './Tabs';

const OPEN: readonly TabItem[] = [
  { id: 'a', label: 'Meeting notes', pinned: true },
  { id: 'b', label: 'Roadmap', pinned: false },
  { id: 'c', label: 'Design review', pinned: true },
];

describe('Tabs', () => {
  it('announces the strip and which document is showing', () => {
    render(<Tabs label="Open documents" items={OPEN} activeId="b" onActivate={vi.fn()} />);

    expect(screen.getByRole('tablist', { name: 'Open documents' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Roadmap' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Meeting notes' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('reports the tab that was clicked', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();

    render(<Tabs label="Open documents" items={OPEN} activeId="a" onActivate={onActivate} />);
    await user.click(screen.getByRole('tab', { name: 'Design review' }));

    expect(onActivate).toHaveBeenCalledWith('c');
  });

  it('moves focus with the arrow keys without activating', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();

    render(<Tabs label="Open documents" items={OPEN} activeId="a" onActivate={onActivate} />);
    screen.getByRole('tab', { name: 'Meeting notes' }).focus();

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Roadmap' })).toHaveFocus();

    // Arrow keys move the roving tab stop, not the selection - each tab carries a live
    // connection, so browsing the strip itself must not activate every tab passed on the way.
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('wraps from the last tab to the first', async () => {
    const user = userEvent.setup();

    render(<Tabs label="Open documents" items={OPEN} activeId="a" onActivate={vi.fn()} />);
    screen.getByRole('tab', { name: 'Design review' }).focus();

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Meeting notes' })).toHaveFocus();
  });

  it('activates the focused tab on Enter', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();

    render(<Tabs label="Open documents" items={OPEN} activeId="a" onActivate={onActivate} />);
    screen.getByRole('tab', { name: 'Roadmap' }).focus();

    await user.keyboard('{Enter}');
    expect(onActivate).toHaveBeenCalledWith('b');
  });

  it('only the active tab is in the tab order', () => {
    render(<Tabs label="Open documents" items={OPEN} activeId="b" onActivate={vi.fn()} />);

    expect(screen.getByRole('tab', { name: 'Roadmap' })).toHaveAttribute('tabIndex', '0');
    expect(screen.getByRole('tab', { name: 'Meeting notes' })).toHaveAttribute('tabIndex', '-1');
    expect(screen.getByRole('tab', { name: 'Design review' })).toHaveAttribute('tabIndex', '-1');
  });

  it('reports which tab was closed, separately from activating it', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    const onClose = vi.fn();

    render(
      <Tabs label="Open documents" items={OPEN} activeId="a" onActivate={onActivate} onClose={onClose} />,
    );
    await user.click(screen.getByRole('button', { name: 'Close Roadmap' }));

    expect(onClose).toHaveBeenCalledWith('b');
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('offers no close control for a tab marked not closable', () => {
    const items: readonly TabItem[] = [
      { id: 'a', label: 'Meeting notes', pinned: true, closable: false },
    ];

    render(<Tabs label="Open documents" items={items} activeId="a" onActivate={vi.fn()} onClose={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Close Meeting notes' })).not.toBeInTheDocument();
  });

  it('offers no close control at all when the caller does not accept one', () => {
    render(<Tabs label="Open documents" items={OPEN} activeId="a" onActivate={vi.fn()} />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('a vertical strip', () => {
  it('says so, rather than leaving assistive technology to assume the default', () => {
    render(
      <Tabs
        label="Open documents"
        items={OPEN}
        activeId="a"
        onActivate={vi.fn()}
        orientation="vertical"
      />,
    );

    expect(screen.getByRole('tablist')).toHaveAttribute('aria-orientation', 'vertical');
  });

  it('does not say so for the horizontal default', () => {
    render(<Tabs label="Open documents" items={OPEN} activeId="a" onActivate={vi.fn()} />);

    expect(screen.getByRole('tablist')).not.toHaveAttribute('aria-orientation');
  });

  it('moves focus with Down and Up rather than Left and Right', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();

    render(
      <Tabs
        label="Open documents"
        items={OPEN}
        activeId="a"
        onActivate={onActivate}
        orientation="vertical"
      />,
    );
    screen.getByRole('tab', { name: 'Meeting notes' }).focus();

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('tab', { name: 'Roadmap' })).toHaveFocus();

    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('tab', { name: 'Meeting notes' })).toHaveFocus();
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('does not answer to the horizontal strip’s own arrow keys', async () => {
    const user = userEvent.setup();

    render(
      <Tabs
        label="Open documents"
        items={OPEN}
        activeId="a"
        onActivate={vi.fn()}
        orientation="vertical"
      />,
    );
    screen.getByRole('tab', { name: 'Meeting notes' }).focus();

    await user.keyboard('{ArrowRight}');
    // A tablist that answered to both axes would be lying about `aria-orientation`.
    expect(screen.getByRole('tab', { name: 'Meeting notes' })).toHaveFocus();
  });
});
