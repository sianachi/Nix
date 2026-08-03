import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { PaneGroup } from './pane-group';
import type { PaneState } from './pane-state';

/**
 * The arrangement on screen, and the handle between the panes.
 *
 * The divider is the piece worth rendering rather than unit-testing: what matters about it is that
 * it is announced as a separator with a value, and that every gesture a pointer can make has a key
 * that makes it too. Neither of those is visible from the outside of a pure function.
 */

const panes: PaneState[] = [
  { index: 0, itemId: '00000000-0000-4000-8000-000000000001' },
  { index: 1, itemId: '00000000-0000-4000-8000-000000000002' },
];

function renderGroup(overrides: Partial<Parameters<typeof PaneGroup>[0]> = {}) {
  const onSizes = vi.fn();

  render(
    <PaneGroup
      panes={panes}
      split="vertical"
      sizes={null}
      onSizes={onSizes}
      describePane={(pane) => (pane.index === 0 ? 'Spec' : 'Notes')}
      renderPane={(pane) => <p>Pane {pane.index}</p>}
      {...overrides}
    />,
  );

  return { onSizes };
}

describe('the pane group', () => {
  it('draws every pane', () => {
    renderGroup();

    expect(screen.getByText('Pane 0')).toBeInTheDocument();
    expect(screen.getByText('Pane 1')).toBeInTheDocument();
  });

  it('puts one handle between two panes, and none before the first', () => {
    renderGroup();

    expect(screen.getAllByRole('separator')).toHaveLength(1);
  });

  it('puts a handle between each pair of three', () => {
    renderGroup({
      panes: [...panes, { index: 2, itemId: '00000000-0000-4000-8000-000000000003' }],
    });

    expect(screen.getAllByRole('separator')).toHaveLength(2);
  });

  it('draws no handle for a single pane', () => {
    renderGroup({ panes: panes.slice(0, 1) });

    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
  });
});

describe('the handle', () => {
  it('says which two panes it moves, rather than only that it is a separator', () => {
    renderGroup();

    expect(screen.getByRole('separator', { name: 'Resize Spec and Notes' })).toBeInTheDocument();
  });

  it('reports its position as a value a screen reader can announce', () => {
    renderGroup();
    const handle = screen.getByRole('separator');

    expect(handle).toHaveAttribute('aria-valuenow', '50');
    expect(handle).toHaveAttribute('aria-valuemin', '15');
    expect(handle).toHaveAttribute('aria-valuemax', '85');
  });

  it('is announced as vertical between panes that sit side by side', () => {
    // The divider's own axis, not the arrangement's: two panes side by side are separated by a
    // vertical line, and that is also the axis the left and right arrows move it along.
    renderGroup();

    expect(screen.getByRole('separator')).toHaveAttribute('aria-orientation', 'vertical');
  });

  it('is announced as horizontal between panes that sit one above the other', () => {
    renderGroup({ split: 'horizontal' });

    expect(screen.getByRole('separator')).toHaveAttribute('aria-orientation', 'horizontal');
  });

  it('takes focus, so it can be reached without a pointer', async () => {
    const user = userEvent.setup();
    renderGroup();

    await user.tab();

    expect(screen.getByRole('separator')).toHaveFocus();
  });
});

describe('moving the handle by keyboard', () => {
  async function press(keys: string, overrides = {}) {
    // Explicit, because two of these tests press twice: the automatic cleanup runs between tests,
    // not between renders inside one, and a second group would leave two handles on screen.
    cleanup();
    const user = userEvent.setup();
    const { onSizes } = renderGroup(overrides);

    screen.getByRole('separator').focus();
    await user.keyboard(keys);

    return onSizes;
  }

  it('moves a step at a time with the arrow keys', async () => {
    // Every gesture a drag offers has a key, which is the whole point: a layout control that only
    // a pointer can operate is a layout control for only some people.
    const onSizes = await press('{ArrowRight}');

    expect(onSizes).toHaveBeenCalledWith([51, 49]);
  });

  it('moves the other way too', async () => {
    const onSizes = await press('{ArrowLeft}');

    expect(onSizes).toHaveBeenCalledWith([49, 51]);
  });

  it('moves further with Shift held', async () => {
    const onSizes = await press('{Shift>}{ArrowRight}{/Shift}');

    expect(onSizes).toHaveBeenCalledWith([60, 40]);
  });

  it('goes to the bounds with Home and End', async () => {
    expect(await press('{Home}')).toHaveBeenCalledWith([15, 85]);
    expect(await press('{End}')).toHaveBeenCalledWith([85, 15]);
  });

  it('will not squeeze a pane past the minimum', async () => {
    // The bound is what keeps a pane from being dragged narrower than its own header controls,
    // which is a state nothing in the interface offers a way out of except dragging back.
    const onSizes = await press('{Shift>}{ArrowRight}{/Shift}', { sizes: [82, 18] });

    expect(onSizes).toHaveBeenCalledWith([85, 15]);
  });

  it('toggles back to even, and back out again', async () => {
    expect(await press('{Enter}', { sizes: [80, 20] })).toHaveBeenCalledWith([50, 50]);
    // From even, the same key goes the other way rather than doing nothing - a control that does
    // nothing when pressed reads as broken.
    expect(await press('{Enter}')).toHaveBeenCalledWith([85, 15]);
  });

  it('undoes an even split back to where it was, not to a bound', async () => {
    // The same key has to reverse itself, and reversing to a bound nobody chose is not a reversal.
    const user = userEvent.setup();
    cleanup();
    const onSizes = vi.fn();
    render(
      <PaneGroup
        panes={panes}
        split="vertical"
        sizes={[70, 30]}
        onSizes={onSizes}
        describePane={() => 'a pane'}
        renderPane={(pane) => <p>Pane {pane.index}</p>}
      />,
    );

    const handle = screen.getByRole('separator');
    handle.focus();
    await user.keyboard('{Enter}');
    expect(onSizes).toHaveBeenLastCalledWith([50, 50]);

    // The group is controlled by its caller, so the second press is made against the evened state
    // the caller would have re-rendered with.
    cleanup();
    render(
      <PaneGroup
        panes={panes}
        split="vertical"
        sizes={[50, 50]}
        onSizes={onSizes}
        describePane={() => 'a pane'}
        renderPane={(pane) => <p>Pane {pane.index}</p>}
      />,
    );
    screen.getByRole('separator').focus();
    await user.keyboard('{Enter}');

    // Without a remembered value there is nothing to go back to, so it falls to a bound - which
    // is why the remembering lives in the divider and survives between presses.
    expect(onSizes).toHaveBeenLastCalledWith([85, 15]);
  });

  it('uses the up and down arrows when the panes are stacked', async () => {
    const onSizes = await press('{ArrowDown}', { split: 'horizontal' });

    expect(onSizes).toHaveBeenCalledWith([51, 49]);
  });

  it('leaves keys it does not claim to the browser', async () => {
    const onSizes = await press('{PageDown}');

    expect(onSizes).not.toHaveBeenCalled();
  });
});

describe('dragging the handle', () => {
  /**
   * A drag, with the geometry stubbed.
   *
   * jsdom lays nothing out, so `getBoundingClientRect` is all zeros and `setPointerCapture` does
   * not exist. Both are stubbed rather than skipped, because what is worth checking here is not
   * the browser's pointer capture - it is the arithmetic that turns a pointer position into a
   * share, and the listener lifecycle that would otherwise leave a drag running after the button
   * came up. A real drag in a real browser is still owed.
   */
  function dragSetup(sizes: readonly number[] | null = null) {
    const onSizes = vi.fn();
    cleanup();

    render(
      <PaneGroup
        panes={panes}
        split="vertical"
        sizes={sizes}
        onSizes={onSizes}
        describePane={() => 'a pane'}
        renderPane={(pane) => <p>Pane {pane.index}</p>}
      />,
    );

    const handle = screen.getByRole('separator');
    handle.setPointerCapture = vi.fn();

    // The pair spans 0-1000; the handle sits between them. A pointer at x tracks to x/10 percent.
    const first = handle.previousElementSibling as HTMLElement;
    const second = handle.nextElementSibling as HTMLElement;
    first.getBoundingClientRect = () => ({ left: 0, top: 0, right: 500, bottom: 800 }) as DOMRect;
    second.getBoundingClientRect = () =>
      ({ left: 500, top: 0, right: 1000, bottom: 800 }) as DOMRect;

    return { handle, onSizes };
  }

  function pointer(type: string, clientX: number): PointerEvent {
    return new PointerEvent(type, { clientX, clientY: 400, button: 0, bubbles: true });
  }

  it('does not commit while the pointer is still down', () => {
    // Every move would otherwise be a URL write, so a single drag would fill the history with a
    // hundred entries and Back would walk through them one pixel at a time.
    const { handle, onSizes } = dragSetup();

    handle.dispatchEvent(pointer('pointerdown', 500));
    handle.dispatchEvent(pointer('pointermove', 700));

    expect(onSizes).not.toHaveBeenCalled();
  });

  it('commits once, on release, at the position the pointer settled', () => {
    const { handle, onSizes } = dragSetup();

    handle.dispatchEvent(pointer('pointerdown', 500));
    handle.dispatchEvent(pointer('pointermove', 700));
    handle.dispatchEvent(pointer('pointerup', 700));

    expect(onSizes).toHaveBeenCalledTimes(1);
    expect(onSizes).toHaveBeenCalledWith([70, 30]);
  });

  it('stops tracking once the button is up', () => {
    // The failure this guards is a handle that keeps following the pointer around the screen
    // after the drag ended, which looks like the page has stopped responding to the mouse.
    const { handle, onSizes } = dragSetup();

    handle.dispatchEvent(pointer('pointerdown', 500));
    handle.dispatchEvent(pointer('pointerup', 700));
    onSizes.mockClear();

    handle.dispatchEvent(pointer('pointermove', 200));

    expect(onSizes).not.toHaveBeenCalled();
  });

  it('stops tracking when the gesture is cancelled rather than finished', () => {
    const { handle, onSizes } = dragSetup();

    handle.dispatchEvent(pointer('pointerdown', 500));
    handle.dispatchEvent(new PointerEvent('pointercancel', { clientX: 700, bubbles: true }));
    onSizes.mockClear();

    handle.dispatchEvent(pointer('pointermove', 200));

    expect(onSizes).not.toHaveBeenCalled();
  });

  it('puts the layout back when the gesture is taken away', () => {
    // A cancelled drag is not a finished one. Committing wherever the pointer happened to be
    // would let an incoming call or a back-swipe resize somebody's screen for them - and the
    // cancel event carries stale coordinates in some engines, so it can be a wild value.
    const { handle, onSizes } = dragSetup([70, 30]);

    handle.dispatchEvent(pointer('pointerdown', 700));
    handle.dispatchEvent(pointer('pointermove', 200));
    handle.dispatchEvent(new PointerEvent('pointercancel', { clientX: 0, bubbles: true }));

    expect(onSizes).not.toHaveBeenCalled();
  });

  it('will not drag a pane past the minimum share', () => {
    const { handle, onSizes } = dragSetup();

    handle.dispatchEvent(pointer('pointerdown', 500));
    handle.dispatchEvent(pointer('pointerup', 20));

    expect(onSizes).toHaveBeenCalledWith([15, 85]);
  });

  it('ignores a secondary button, so a context menu does not start a drag', () => {
    const { handle, onSizes } = dragSetup();

    handle.dispatchEvent(
      new PointerEvent('pointerdown', { clientX: 500, button: 2, bubbles: true }),
    );
    handle.dispatchEvent(pointer('pointerup', 700));

    expect(onSizes).not.toHaveBeenCalled();
  });
});
