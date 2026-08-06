import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, useRef, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Toast } from './Toast';

function setupUser() {
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Toast', () => {
  it('reports itself as a status rather than an alert, since it advises rather than interrupts', () => {
    render(<Toast message='Deleted "Roadmap".' onDismiss={vi.fn()} />);

    expect(screen.getByRole('status')).toHaveTextContent('Deleted "Roadmap".');
  });

  it('offers the action it is given, alongside a way to dismiss without acting', () => {
    render(
      <Toast
        message='Deleted "Roadmap".'
        action={{ label: 'Undo', onAction: vi.fn() }}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  it('offers only the dismiss control when it has no action to offer', () => {
    render(<Toast message='Deleted "Roadmap".' onDismiss={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  it('moves focus to its action on mount, since whatever triggered it is usually already gone', () => {
    render(
      <Toast
        message="Deleted."
        action={{ label: 'Undo', onAction: vi.fn() }}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Undo' })).toHaveFocus();
  });

  it('moves focus to dismiss instead, when there is no action to focus', () => {
    render(<Toast message="Deleted." onDismiss={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Dismiss' })).toHaveFocus();
  });

  it('does not move focus on mount when autoFocus is false, since the reader may already be elsewhere on purpose', () => {
    render(
      <>
        <button>Already doing something else</button>
        {/* Justification: this is `<Toast>`'s own `autoFocus` prop, opting out of its mount-focus
            effect - not the native DOM `autofocus` attribute the rule guards against. */}
        {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
        <Toast message="Deleted." onDismiss={vi.fn()} autoFocus={false} />
      </>,
    );

    expect(screen.getByRole('button', { name: 'Dismiss' })).not.toHaveFocus();
  });

  it('runs the action and closes when Undo is pressed', async () => {
    const user = setupUser();
    const onAction = vi.fn();
    const onDismiss = vi.fn();
    render(<Toast message="Deleted." action={{ label: 'Undo', onAction }} onDismiss={onDismiss} />);

    await user.click(screen.getByRole('button', { name: 'Undo' }));

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('closes without acting when the dismiss control is pressed', async () => {
    const user = setupUser();
    const onAction = vi.fn();
    const onDismiss = vi.fn();
    render(<Toast message="Deleted." action={{ label: 'Undo', onAction }} onDismiss={onDismiss} />);

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(onAction).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('dismisses itself once the default timeout elapses', () => {
    const onDismiss = vi.fn();
    render(<Toast message="Deleted." onDismiss={onDismiss} />);

    vi.advanceTimersByTime(8000);

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('honors a caller-supplied duration instead of the default', () => {
    const onDismiss = vi.fn();
    render(<Toast message="Deleted." onDismiss={onDismiss} duration={3000} />);

    vi.advanceTimersByTime(2999);
    expect(onDismiss).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does not time out while the pointer is over it, so a slow reach for Undo is not punished', async () => {
    const user = setupUser();
    const onDismiss = vi.fn();
    render(
      <Toast
        message="Deleted."
        action={{ label: 'Undo', onAction: vi.fn() }}
        onDismiss={onDismiss}
      />,
    );

    await user.hover(screen.getByRole('status'));
    vi.advanceTimersByTime(20000);

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('restarts the countdown from the full duration once the pointer leaves', async () => {
    const user = setupUser();
    const onDismiss = vi.fn();
    // A short, exact duration rather than the 8s default: `shouldAdvanceTime` (`beforeEach`
    // above) lets the fake clock drift forward with real wall-clock time as this test's own
    // `await`s run, which makes an assertion pinned to the last millisecond before a long timeout
    // fires flaky. A duration two orders of magnitude smaller keeps that drift negligible next to
    // the gap this test actually cares about.
    render(<Toast message="Deleted." onDismiss={onDismiss} duration={100} />);

    const status = screen.getByRole('status');
    await user.hover(status);
    vi.advanceTimersByTime(500);
    await user.unhover(status);

    // A restart from the full duration, not a resume of whatever was left when the hover began -
    // the component's own doc explains the distinction and why a restart was kept. Immediately
    // after unhovering there should be (about) a full duration left, not none.
    expect(onDismiss).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does not time out while keyboard focus is inside it, so tabbing between its own controls is not a race', async () => {
    const user = setupUser();
    const onDismiss = vi.fn();
    render(
      <Toast
        message="Deleted."
        action={{ label: 'Undo', onAction: vi.fn() }}
        onDismiss={onDismiss}
      />,
    );

    // Focus already landed on Undo when the toast mounted (the mount-focus effect); tabbing to
    // Dismiss is a genuine focus change and exercises the pause the same way a keyboard user
    // lingering inside the toast would.
    await user.tab();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toHaveFocus();

    vi.advanceTimersByTime(20000);

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('returns focus to the nominated element when the toast unmounts', () => {
    function Scene({ showToast }: { showToast: boolean }): ReactNode {
      const ref = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={ref}>Back to the tree</button>
          {showToast ? <Toast message="Deleted." onDismiss={vi.fn()} returnFocusRef={ref} /> : null}
        </>
      );
    }

    const { rerender } = render(<Scene showToast />);
    rerender(<Scene showToast={false} />);

    expect(screen.getByRole('button', { name: 'Back to the tree' })).toHaveFocus();
  });

  it('does not throw when the nominated element is already gone', () => {
    const ref = createRef<HTMLButtonElement>();
    const { unmount } = render(
      <Toast message="Deleted." onDismiss={vi.fn()} returnFocusRef={ref} />,
    );

    expect(() => {
      unmount();
    }).not.toThrow();
  });

  it('does not move focus on unmount when focus has already left it for somewhere else', async () => {
    const user = setupUser();

    function Scene({ showToast }: { showToast: boolean }): ReactNode {
      const ref = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={ref}>Back to the tree</button>
          <button>A document, elsewhere on the page</button>
          {showToast ? <Toast message="Deleted." onDismiss={vi.fn()} returnFocusRef={ref} /> : null}
        </>
      );
    }

    const { rerender } = render(<Scene showToast />);

    // The reader ignored the toast and went back to whatever they were doing - the ordinary path,
    // not the exception. Unlike `<Dialog>`, which is modal and can restore its invoker
    // unconditionally, a toast reclaiming focus from here on unmount would rip it out of a
    // document a person is actively working in.
    await user.click(screen.getByRole('button', { name: 'A document, elsewhere on the page' }));
    rerender(<Scene showToast={false} />);

    expect(screen.getByRole('button', { name: 'A document, elsewhere on the page' })).toHaveFocus();
  });

  it('keeps using the latest onDismiss and fires it only once, even if the caller re-renders with a fresh closure partway through the countdown', () => {
    const firstOnDismiss = vi.fn();
    const secondOnDismiss = vi.fn();

    function Scene({ onDismiss }: { onDismiss: () => void }): ReactNode {
      return <Toast message="Deleted." onDismiss={onDismiss} />;
    }

    const { rerender } = render(<Scene onDismiss={firstOnDismiss} />);

    vi.advanceTimersByTime(6000);
    rerender(<Scene onDismiss={secondOnDismiss} />);

    // If the timer effect depended on `onDismiss` directly instead of through `onDismissRef`, this
    // re-render would restart the countdown from zero - the 2000ms remaining here would not be
    // enough to fire it, and the assertion below would fail.
    vi.advanceTimersByTime(2000);

    expect(secondOnDismiss).toHaveBeenCalledTimes(1);
    expect(firstOnDismiss).not.toHaveBeenCalled();
  });

  it('dismisses on Escape, and keeps an outer window listener from also reacting to the same keypress', async () => {
    const user = setupUser();
    const onDismiss = vi.fn();
    const outerListener = vi.fn();
    // `window`, not `document`: that is where the real conflict this guards against lives - the
    // off-canvas drawer's own Escape listener (`sidebar-drawer.tsx`) is on `window` specifically so
    // that stopping propagation at `document` (below) is enough to keep it from also firing.
    window.addEventListener('keydown', outerListener);

    try {
      render(<Toast message="Deleted." onDismiss={onDismiss} />);

      await user.keyboard('{Escape}');

      expect(onDismiss).toHaveBeenCalledTimes(1);
      expect(outerListener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', outerListener);
    }
  });

  it('does not dismiss on Escape when focus is elsewhere, so it does not silently defeat another surface handling its own Escape', async () => {
    const user = setupUser();
    const onDismiss = vi.fn();
    render(
      <>
        <button>Elsewhere on the page</button>
        <Toast message="Deleted." onDismiss={onDismiss} />
      </>,
    );

    // The mount-focus effect lands focus on the toast's own Dismiss control first; moving it away
    // - the same way opening the off-canvas drawer's toggle, the spreadsheet grid, or the slash
    // menu would - is what this test needs in place before Escape is pressed.
    await user.click(screen.getByRole('button', { name: 'Elsewhere on the page' }));
    await user.keyboard('{Escape}');

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('dismisses only the toast that holds focus when two are mounted, so one keypress cannot close both', async () => {
    const user = setupUser();
    const firstDismiss = vi.fn();
    const secondDismiss = vi.fn();
    render(
      <>
        <Toast message="First." onDismiss={firstDismiss} />
        <Toast message="Second." onDismiss={secondDismiss} />
      </>,
    );

    // Both mount in the same pass, but the second's own mount-focus effect runs after the first's
    // and lands focus last - matching `app-shell.tsx`'s two-slot queue, where the newer toast is
    // the one closest to wherever a hand already is right after a delete.
    await user.keyboard('{Escape}');

    expect(secondDismiss).toHaveBeenCalledTimes(1);
    expect(firstDismiss).not.toHaveBeenCalled();
  });

  it('describes its buttons with the message, so a screen reader has the context even when focus lands directly on one', () => {
    render(
      <Toast
        message='Deleted "Roadmap".'
        action={{ label: 'Undo', onAction: vi.fn() }}
        onDismiss={vi.fn()}
      />,
    );

    screen.getByText('Deleted "Roadmap".');
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveAccessibleDescription(
      'Deleted "Roadmap".',
    );
    expect(screen.getByRole('button', { name: 'Dismiss' })).toHaveAccessibleDescription(
      'Deleted "Roadmap".',
    );
  });

  it('does not restyle the action or dismiss buttons - both keep the standard control contract', () => {
    render(
      <Toast
        message="Deleted."
        action={{ label: 'Undo', onAction: vi.fn() }}
        onDismiss={vi.fn()}
      />,
    );

    // `<Button>`'s own doc states `className` is layout-only and never a restyle of the control;
    // this asserts neither button here reaches past that contract the way an earlier version did
    // (a `text-xs` override on Undo, a `size-6 p-0` override shrinking Dismiss to the WCAG 2.5.8
    // floor rather than clearing it).
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveClass('text-md');
    expect(screen.getByRole('button', { name: 'Dismiss' })).toHaveClass('w-(--control-md)');
  });
});
