import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContextMenu, LONG_PRESS_MS } from './ContextMenu';
import { type MenuEntry } from './Menu';

function Row({
  items,
  onClick = vi.fn(),
  onMouseDown = vi.fn(),
}: {
  readonly items: readonly MenuEntry[] | (() => readonly MenuEntry[]);
  readonly onClick?: () => void;
  readonly onMouseDown?: () => void;
}) {
  return (
    <ContextMenu label="Page actions" items={items}>
      {(target) => (
        <div {...target}>
          <button type="button" onClick={onClick} onMouseDown={onMouseDown}>
            Quarterly plan
          </button>
          <input aria-label="Rename" />
        </div>
      )}
    </ContextMenu>
  );
}

describe('ContextMenu', () => {
  afterEach(() => {
    vi.useRealTimers();
    getSelection()?.removeAllRanges();
  });

  it('opens its own menu on a secondary click instead of the browser menu', () => {
    const onSelect = vi.fn();
    render(<Row items={[{ kind: 'action', label: 'Open beside', onSelect }]} />);

    const opened = fireEvent.contextMenu(screen.getByRole('button', { name: 'Quarterly plan' }), {
      clientX: 40,
      clientY: 60,
    });

    // fireEvent returns false when the default - the browser's menu - was prevented.
    expect(opened).toBe(false);
    expect(screen.getByRole('menu', { name: 'Page actions' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Open beside' })).toHaveFocus();
  });

  it('runs a choice once, closes, and returns focus to where it was', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Row items={[{ kind: 'action', label: 'Open beside', onSelect }]} />);
    const row = screen.getByRole('button', { name: 'Quarterly plan' });
    row.focus();

    fireEvent.contextMenu(row, { clientX: 40, clientY: 60 });
    await user.click(screen.getByRole('menuitem', { name: 'Open beside' }));

    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(row).toHaveFocus();
    });
  });

  it('keeps a menu inside the native dialog that owns its target', () => {
    render(
      <dialog open aria-label="Page settings">
        <Row items={[{ label: 'Bookmark', onSelect: vi.fn() }]} />
      </dialog>,
    );
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Quarterly plan' }));
    expect(screen.getByRole('menu').parentElement).toBe(
      screen.getByRole('dialog', { name: 'Page settings' }),
    );
  });

  it('keeps focus on an editor opened by a menu action', async () => {
    render(
      <>
        <Row
          items={[
            {
              label: 'Edit title',
              onSelect: () => {
                screen.getByRole('textbox', { name: 'Title editor' }).focus();
              },
            },
          ]}
        />
        <input aria-label="Title editor" />
      </>,
    );
    const row = screen.getByRole('button', { name: 'Quarterly plan' });
    row.focus();
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit title' }));
    await act(() => new Promise(requestAnimationFrame));
    expect(screen.getByRole('textbox', { name: 'Title editor' })).toHaveFocus();
  });

  it('closes on Escape and on a click elsewhere', async () => {
    const user = userEvent.setup();
    render(<Row items={[{ kind: 'action', label: 'Open beside', onSelect: vi.fn() }]} />);
    const row = screen.getByRole('button', { name: 'Quarterly plan' });

    fireEvent.contextMenu(row, { clientX: 40, clientY: 60 });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.contextMenu(row, { clientX: 40, clientY: 60 });
    await user.click(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('leaves the browser menu on text fields, where paste and spelling live', () => {
    render(<Row items={[{ kind: 'action', label: 'Open beside', onSelect: vi.fn() }]} />);

    const opened = fireEvent.contextMenu(screen.getByRole('textbox', { name: 'Rename' }));

    expect(opened).toBe(true);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('leaves the browser menu alone when there is nothing to offer', () => {
    render(<Row items={() => []} />);

    const opened = fireEvent.contextMenu(screen.getByRole('button', { name: 'Quarterly plan' }));

    expect(opened).toBe(true);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('builds its entries when it opens, so they reflect the moment of the request', () => {
    let label = 'Bookmark';
    render(<Row items={() => [{ kind: 'action', label, onSelect: vi.fn() }]} />);
    label = 'Remove bookmark';

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Quarterly plan' }));

    expect(screen.getByRole('menuitem', { name: 'Remove bookmark' })).toBeInTheDocument();
  });

  it('opens on a held touch, and the lifting tap does not also activate the row', () => {
    vi.useFakeTimers();
    const onClick = vi.fn();
    const onMouseDown = vi.fn();
    render(
      <Row
        items={[{ kind: 'action', label: 'Open beside', onSelect: vi.fn() }]}
        onClick={onClick}
        onMouseDown={onMouseDown}
      />,
    );
    const row = screen.getByRole('button', { name: 'Quarterly plan' });

    fireEvent.pointerDown(row, { pointerType: 'touch', clientX: 10, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    fireEvent.pointerUp(row, { pointerType: 'touch' });
    fireEvent.mouseDown(row);
    fireEvent.click(row);

    expect(screen.getByRole('menu', { name: 'Page actions' })).toBeInTheDocument();
    expect(onClick).not.toHaveBeenCalled();
    expect(onMouseDown).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('treats a touch that moves as a scroll, not a press', () => {
    vi.useFakeTimers();
    render(<Row items={[{ kind: 'action', label: 'Open beside', onSelect: vi.fn() }]} />);
    const row = screen.getByRole('button', { name: 'Quarterly plan' });

    fireEvent.pointerDown(row, { pointerType: 'touch', clientX: 10, clientY: 10 });
    fireEvent.pointerMove(row, { pointerType: 'touch', clientX: 10, clientY: 40 });
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('swallows activation when Android asks for the menu before the long-press timer fires', () => {
    vi.useFakeTimers();
    const onClick = vi.fn();
    render(<Row items={[{ label: 'Bookmark', onSelect: vi.fn() }]} onClick={onClick} />);
    const row = screen.getByRole('button', { name: 'Quarterly plan' });
    fireEvent.pointerDown(row, { pointerType: 'touch' });
    expect(fireEvent.contextMenu(row, { clientX: 10, clientY: 10 })).toBe(false);
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    fireEvent.pointerUp(row, { pointerType: 'touch' });
    fireEvent.click(row);
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it.each(['pointerup', 'pointercancel', 'scroll', 'blur'])(
    'cancels a held touch when %s happens outside the target',
    (type) => {
      vi.useFakeTimers();
      render(<Row items={[{ label: 'Bookmark', onSelect: vi.fn() }]} />);
      const row = screen.getByRole('button', { name: 'Quarterly plan' });
      fireEvent.pointerDown(row, { pointerType: 'touch', pointerId: 7 });
      if (type === 'blur') fireEvent.blur(window);
      else if (type === 'scroll') fireEvent.scroll(document.body);
      else
        fireEvent(
          document.body,
          new PointerEvent(type, { pointerType: 'touch', pointerId: 7, bubbles: true }),
        );
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS);
      });
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    },
  );

  it('cancels a held touch when another finger touches the same target', () => {
    vi.useFakeTimers();
    render(<Row items={[{ label: 'Bookmark', onSelect: vi.fn() }]} />);
    const row = screen.getByRole('button', { name: 'Quarterly plan' });
    fireEvent.pointerDown(row, { pointerType: 'touch', pointerId: 7 });
    const second = new PointerEvent('pointerdown', {
      pointerType: 'touch',
      pointerId: 8,
      isPrimary: false,
      bubbles: true,
    });
    fireEvent(row, second);
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens only the innermost menu for a held touch', () => {
    vi.useFakeTimers();
    render(
      <ContextMenu label="Folder actions" items={[{ label: 'Rename folder', onSelect: vi.fn() }]}>
        {(target) => (
          <div {...target}>
            <Row items={[{ label: 'Bookmark', onSelect: vi.fn() }]} />
          </div>
        )}
      </ContextMenu>,
    );
    const row = screen.getByRole('button', { name: 'Quarterly plan' });
    fireEvent.pointerDown(row, { pointerType: 'touch' });
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(screen.getByRole('menu', { name: 'Page actions' })).toBeInTheDocument();
    expect(fireEvent.contextMenu(row, { clientX: 10, clientY: 10 })).toBe(false);
    expect(screen.getAllByRole('menu')).toHaveLength(1);
  });

  it('leaves nested disclosures, toggles and secondary controls to their own gestures', () => {
    vi.useFakeTimers();
    render(
      <ContextMenu label="Page actions" items={[{ label: 'Bookmark', onSelect: vi.fn() }]}>
        {(target) => (
          <div {...target}>
            <button aria-haspopup="dialog">Reschedule</button>
            <button aria-pressed="false">Pin</button>
            <button aria-expanded="false">Expand</button>
            <button data-context-menu-ignore>Clear reminder</button>
            <details>
              <summary>Fields</summary>
              <p>Deadline</p>
            </details>
          </div>
        )}
      </ContextMenu>,
    );
    for (const label of ['Reschedule', 'Pin', 'Expand', 'Clear reminder', 'Fields']) {
      const control = screen.getByText(label);
      fireEvent.pointerDown(control, { pointerType: 'touch' });
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS);
      });
      expect(fireEvent.contextMenu(control)).toBe(true);
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      fireEvent.pointerUp(control, { pointerType: 'touch' });
    }
  });

  it('opens from Shift+F10 and the Menu key, which macOS never turns into a context menu', async () => {
    render(<Row items={[{ kind: 'action', label: 'Open beside', onSelect: vi.fn() }]} />);
    const row = screen.getByRole('button', { name: 'Quarterly plan' });
    row.focus();

    expect(fireEvent.keyDown(row, { key: 'F10', shiftKey: true })).toBe(false);
    expect(screen.getByRole('menu', { name: 'Page actions' })).toBeInTheDocument();

    await userEvent.setup().keyboard('{Escape}');
    expect(fireEvent.keyDown(row, { key: 'ContextMenu' })).toBe(false);
    expect(screen.getByRole('menu', { name: 'Page actions' })).toBeInTheDocument();
  });

  it('does not keep eating taps after a long press whose tap never arrived', () => {
    vi.useFakeTimers();
    const onClick = vi.fn();
    render(
      <Row
        items={[{ kind: 'action', label: 'Open beside', onSelect: vi.fn() }]}
        onClick={onClick}
      />,
    );
    const row = screen.getByRole('button', { name: 'Quarterly plan' });

    fireEvent.pointerDown(row, { pointerType: 'touch', clientX: 10, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    // The lifting touch landed on the menu, not the row; the next deliberate tap is a new press.
    fireEvent.pointerDown(row, { pointerType: 'touch', clientX: 10, clientY: 10 });
    fireEvent.pointerUp(row, { pointerType: 'touch' });
    fireEvent.click(row);

    expect(onClick).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('leaves the browser menu on text the person has selected, so they can copy it', () => {
    render(<Row items={[{ kind: 'action', label: 'Open beside', onSelect: vi.fn() }]} />);
    const row = screen.getByRole('button', { name: 'Quarterly plan' });
    const range = document.createRange();
    range.selectNodeContents(row);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);

    expect(fireEvent.contextMenu(row, { clientX: 5, clientY: 5 })).toBe(true);
    getSelection()?.removeAllRanges();
  });

  it('preserves selections that cross the menu target boundary, including keyboard requests', () => {
    render(
      <>
        <Row items={[{ label: 'Bookmark', onSelect: vi.fn() }]} />
        <p>Other text</p>
      </>,
    );
    const row = screen.getByRole('button', { name: 'Quarterly plan' });
    const range = document.createRange();
    range.setStart(row, 0);
    range.setEnd(screen.getByText('Other text'), 1);
    getSelection()?.addRange(range);
    expect(fireEvent.contextMenu(row)).toBe(true);
    expect(fireEvent.keyDown(row, { key: 'F10', shiftKey: true })).toBe(true);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('cancels the menu when a held touch becomes a text selection', () => {
    vi.useFakeTimers();
    render(<Row items={[{ label: 'Bookmark', onSelect: vi.fn() }]} />);
    const row = screen.getByRole('button', { name: 'Quarterly plan' });
    fireEvent.pointerDown(row, { pointerType: 'touch' });
    const range = document.createRange();
    range.selectNodeContents(row);
    getSelection()?.addRange(range);
    fireEvent(document, new Event('selectionchange'));
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('cancels a long press that turns into a drag', () => {
    vi.useFakeTimers();
    render(<Row items={[{ kind: 'action', label: 'Open beside', onSelect: vi.fn() }]} />);
    const row = screen.getByRole('button', { name: 'Quarterly plan' });

    fireEvent.pointerDown(row, { pointerType: 'touch', clientX: 10, clientY: 10 });
    fireEvent.dragStart(row);
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    vi.useRealTimers();
  });
});
