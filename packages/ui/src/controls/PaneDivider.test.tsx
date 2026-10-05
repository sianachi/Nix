import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { PaneDivider, type PaneDividerProps } from './PaneDivider';

/**
 * The window splitter itself, tested between two plain boxes: what matters about it is that it is
 * announced as a separator with a value, and that every gesture a pointer can make has a key that
 * makes it too. How a group of panes wires several of these together is the group's own test,
 * over in apps/web.
 */

function renderDivider(overrides: Partial<PaneDividerProps> = {}) {
  const onPreview = vi.fn();
  const onCommit = vi.fn();

  // Rendered between two siblings, because that is the component's documented contract: a drag
  // measures the pair through `previousElementSibling` and `nextElementSibling`.
  render(
    <div>
      <div id="pane-spec">first pane</div>
      <PaneDivider
        orientation="vertical"
        before={50}
        after={50}
        beforeName="Spec"
        afterName="Notes"
        controls="pane-spec"
        onPreview={onPreview}
        onCommit={onCommit}
        {...overrides}
      />
      <div>second pane</div>
    </div>,
  );

  return { onPreview, onCommit };
}

describe('the divider as a screen reader hears it', () => {
  it('says which two panes it moves, rather than only that it is a separator', () => {
    renderDivider();

    expect(screen.getByRole('separator', { name: 'Resize Spec and Notes' })).toBeInTheDocument();
  });

  it('reports its position as a value a screen reader can announce', () => {
    renderDivider();
    const handle = screen.getByRole('separator');

    expect(handle).toHaveAttribute('aria-valuenow', '50');
    expect(handle).toHaveAttribute('aria-valuemin', '15');
    expect(handle).toHaveAttribute('aria-valuemax', '85');
  });

  it('gives the value a subject, so a bare number is not announced alone', () => {
    renderDivider({ before: 70, after: 30 });

    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuetext', '70 percent to Spec');
  });

  it('points at the pane its value is a share of, not only at prose about it', () => {
    // The window-splitter pattern is a value about something: without `aria-controls`, "70
    // percent to Spec" names its subject only inside the label's sentence, and assistive
    // technology has no way to travel from the handle to the region it moves.
    renderDivider();

    expect(screen.getByRole('separator')).toHaveAttribute('aria-controls', 'pane-spec');
  });

  it('names itself after both neighbours without every caller writing the sentence', () => {
    renderDivider({ beforeName: 'Roadmap', afterName: 'Tasks' });

    expect(screen.getByRole('separator', { name: 'Resize Roadmap and Tasks' })).toBeInTheDocument();
  });

  it('takes a name of its own when the composed sentence is not the right one', () => {
    renderDivider({ label: 'Resize the outline against the draft' });

    expect(
      screen.getByRole('separator', { name: 'Resize the outline against the draft' }),
    ).toBeInTheDocument();
  });

  it('is announced as vertical between panes that sit side by side', () => {
    // The divider's own axis, not the arrangement's: two panes side by side are separated by a
    // vertical line, and that is also the axis the left and right arrows move it along.
    renderDivider();

    expect(screen.getByRole('separator')).toHaveAttribute('aria-orientation', 'vertical');
  });

  it('is announced as horizontal between panes that sit one above the other', () => {
    renderDivider({ orientation: 'horizontal' });

    expect(screen.getByRole('separator')).toHaveAttribute('aria-orientation', 'horizontal');
  });

  it('takes focus, so it can be reached without a pointer', async () => {
    const user = userEvent.setup();
    renderDivider();

    await user.tab();

    expect(screen.getByRole('separator')).toHaveFocus();
  });
});

describe('moving the divider by keyboard', () => {
  async function press(keys: string, overrides: Partial<PaneDividerProps> = {}) {
    // Explicit, because some of these tests render twice: the automatic cleanup runs between
    // tests, not between renders inside one, and a second divider would leave two handles.
    cleanup();
    const user = userEvent.setup();
    const { onCommit } = renderDivider(overrides);

    screen.getByRole('separator').focus();
    await user.keyboard(keys);

    return onCommit;
  }

  it('moves a step at a time with the arrow keys', async () => {
    // Every gesture a drag offers has a key, which is the whole point: a layout control that only
    // a pointer can operate is a layout control for only some people.
    const onCommit = await press('{ArrowRight}');

    expect(onCommit).toHaveBeenCalledWith(51, 49);
  });

  it('moves the other way too', async () => {
    const onCommit = await press('{ArrowLeft}');

    expect(onCommit).toHaveBeenCalledWith(49, 51);
  });

  it('moves further with Shift held', async () => {
    const onCommit = await press('{Shift>}{ArrowRight}{/Shift}');

    expect(onCommit).toHaveBeenCalledWith(60, 40);
  });

  it('goes to the bounds with Home and End', async () => {
    expect(await press('{Home}')).toHaveBeenCalledWith(15, 85);
    expect(await press('{End}')).toHaveBeenCalledWith(85, 15);
  });

  it('will not squeeze a pane past the minimum', async () => {
    // The bound is what keeps a pane from being dragged narrower than its own header controls,
    // which is a state nothing in the interface offers a way out of except dragging back.
    const onCommit = await press('{Shift>}{ArrowRight}{/Shift}', { before: 82, after: 18 });

    expect(onCommit).toHaveBeenCalledWith(85, 15);
  });

  it('toggles back to even, and back out again', async () => {
    expect(await press('{Enter}', { before: 80, after: 20 })).toHaveBeenCalledWith(50, 50);
    // From even, the same key goes the other way rather than doing nothing - a control that does
    // nothing when pressed reads as broken.
    expect(await press('{Enter}')).toHaveBeenCalledWith(85, 15);
  });

  it('undoes an even split back to where it was, not to a bound', async () => {
    // The same key has to reverse itself, and reversing to a bound nobody chose is not a
    // reversal - which is why the remembering lives in the divider and survives between presses.
    cleanup();
    const user = userEvent.setup();
    const onCommit = vi.fn();

    function arrangement(before: number, after: number) {
      return (
        <div>
          <div id="pane-spec">first pane</div>
          <PaneDivider
            orientation="vertical"
            before={before}
            after={after}
            beforeName="Spec"
            afterName="Notes"
            controls="pane-spec"
            onPreview={() => undefined}
            onCommit={onCommit}
          />
          <div>second pane</div>
        </div>
      );
    }

    const { rerender } = render(arrangement(70, 30));
    screen.getByRole('separator').focus();
    await user.keyboard('{Enter}');
    expect(onCommit).toHaveBeenLastCalledWith(50, 50);

    // The divider is controlled by its caller, so the second press is made against the evened
    // state the caller re-rendered with - same instance, so the remembered value survives.
    rerender(arrangement(50, 50));
    screen.getByRole('separator').focus();
    await user.keyboard('{Enter}');

    expect(onCommit).toHaveBeenLastCalledWith(70, 30);
  });

  it('uses the up and down arrows when the panes are stacked', async () => {
    const onCommit = await press('{ArrowDown}', { orientation: 'horizontal' });

    expect(onCommit).toHaveBeenCalledWith(51, 49);
  });

  it('leaves keys it does not claim to the browser', async () => {
    const onCommit = await press('{PageDown}');

    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe('dragging the divider', () => {
  /**
   * A drag, with the geometry stubbed.
   *
   * jsdom lays nothing out, so `getBoundingClientRect` is all zeros and `setPointerCapture` does
   * not exist. Both are stubbed rather than skipped, because what is worth checking here is not
   * the browser's pointer capture - it is the arithmetic that turns a pointer position into a
   * share, and the listener lifecycle that would otherwise leave a drag running after the button
   * came up. A real drag in a real browser is still owed.
   */
  function dragSetup(overrides: Partial<PaneDividerProps> = {}) {
    const { onPreview, onCommit } = renderDivider(overrides);

    const handle = screen.getByRole('separator');
    handle.setPointerCapture = vi.fn();

    // The pair spans 0-1000; the handle sits between them. A pointer at x tracks to x/10 percent.
    const first = handle.previousElementSibling as HTMLElement;
    const second = handle.nextElementSibling as HTMLElement;
    first.getBoundingClientRect = () => ({ left: 0, top: 0, right: 500, bottom: 800 }) as DOMRect;
    second.getBoundingClientRect = () =>
      ({ left: 500, top: 0, right: 1000, bottom: 800 }) as DOMRect;

    return { handle, onPreview, onCommit };
  }

  function pointer(type: string, clientX: number): PointerEvent {
    return new PointerEvent(type, { clientX, clientY: 400, button: 0, bubbles: true });
  }

  it('previews while the pointer is down, and does not commit', () => {
    // Every move would otherwise be a settled write - in the app, a URL entry per pixel.
    const { handle, onPreview, onCommit } = dragSetup();

    handle.dispatchEvent(pointer('pointerdown', 500));
    handle.dispatchEvent(pointer('pointermove', 700));

    expect(onPreview).toHaveBeenCalledWith(70, 30);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('commits once, on release, at the position the pointer settled', () => {
    const { handle, onCommit } = dragSetup();

    handle.dispatchEvent(pointer('pointerdown', 500));
    handle.dispatchEvent(pointer('pointermove', 700));
    handle.dispatchEvent(pointer('pointerup', 700));

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(70, 30);
  });

  it('stops tracking once the button is up', () => {
    // The failure this guards is a handle that keeps following the pointer around the screen
    // after the drag ended, which looks like the page has stopped responding to the mouse.
    const { handle, onPreview, onCommit } = dragSetup();

    handle.dispatchEvent(pointer('pointerdown', 500));
    handle.dispatchEvent(pointer('pointerup', 700));
    onPreview.mockClear();
    onCommit.mockClear();

    handle.dispatchEvent(pointer('pointermove', 200));

    expect(onPreview).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('puts the layout back when the gesture is taken away', () => {
    // A cancelled drag is not a finished one. Committing wherever the pointer happened to be
    // would let an incoming call or a back-swipe resize somebody's screen for them - and the
    // cancel event carries stale coordinates in some engines, so it can be a wild value.
    const { handle, onPreview, onCommit } = dragSetup({ before: 70, after: 30 });

    handle.dispatchEvent(pointer('pointerdown', 700));
    handle.dispatchEvent(pointer('pointermove', 200));
    handle.dispatchEvent(new PointerEvent('pointercancel', { clientX: 0, bubbles: true }));

    expect(onCommit).not.toHaveBeenCalled();
    expect(onPreview).toHaveBeenLastCalledWith(70, 30);

    onPreview.mockClear();
    handle.dispatchEvent(pointer('pointermove', 200));
    expect(onPreview).not.toHaveBeenCalled();
  });

  it('will not drag a pane past the minimum share', () => {
    const { handle, onCommit } = dragSetup();

    handle.dispatchEvent(pointer('pointerdown', 500));
    handle.dispatchEvent(pointer('pointerup', 20));

    expect(onCommit).toHaveBeenCalledWith(15, 85);
  });

  it('marks itself as dragging while the pointer is down, and stops when it comes up', () => {
    // The drawn line's pressed step hangs off this attribute rather than `:active`, which a
    // pointer capture hides from CSS entirely - see `dragHandleLineStates`.
    const { handle } = dragSetup();

    handle.dispatchEvent(pointer('pointerdown', 500));
    expect(handle).toHaveAttribute('data-dragging', 'true');

    handle.dispatchEvent(pointer('pointerup', 700));
    expect(handle).not.toHaveAttribute('data-dragging');
  });

  it('clears the dragging mark when the gesture is taken away rather than finished', () => {
    const { handle } = dragSetup();

    handle.dispatchEvent(pointer('pointerdown', 500));
    handle.dispatchEvent(new PointerEvent('pointercancel', { clientX: 0, bubbles: true }));

    expect(handle).not.toHaveAttribute('data-dragging');
  });

  it('says so in development when it is not rendered between the panes it resizes', () => {
    // A misplaced handle keys and announces perfectly and silently cannot be dragged, which is
    // the hardest kind of bug to see. The warning is the only thing that says which two thirds
    // of the control are working.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const onCommit = vi.fn();

    render(
      <div>
        <PaneDivider
          orientation="vertical"
          before={50}
          after={50}
          beforeName="Spec"
          afterName="Notes"
          controls="pane-spec"
          onPreview={() => undefined}
          onCommit={onCommit}
        />
      </div>,
    );

    const handle = screen.getByRole('separator');
    handle.setPointerCapture = vi.fn();
    handle.dispatchEvent(pointer('pointerdown', 500));

    expect(warn).toHaveBeenCalledWith(
      'PaneDivider: expected the two elements it resizes as its immediate siblings.',
    );
    expect(onCommit).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('ignores a secondary button, so a context menu does not start a drag', () => {
    const { handle, onPreview, onCommit } = dragSetup();

    handle.dispatchEvent(
      new PointerEvent('pointerdown', { clientX: 500, button: 2, bubbles: true }),
    );
    handle.dispatchEvent(pointer('pointerup', 700));

    expect(onPreview).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });
});
