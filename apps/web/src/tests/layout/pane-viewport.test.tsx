import { act, fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PaneViewport } from '../../layout/pane-viewport';

/** The pane div itself carries no role to query by - it is a scroller, not a control. */
function findPane(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>('[data-pane-viewport]');
  if (found === null) {
    throw new Error('Expected the harness to have rendered a pane viewport.');
  }
  return found;
}

/** Stands in for the real geometry jsdom never lays out: `scrollHeight`/`clientHeight` are
 * both always 0 there, so a test that cares about "is `target` reachable yet" has to set them
 * itself. */
function setGeometry(
  pane: HTMLElement,
  { scrollHeight, clientHeight }: { readonly scrollHeight: number; readonly clientHeight: number },
): void {
  Object.defineProperty(pane, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(pane, 'clientHeight', { configurable: true, value: clientHeight });
}

/** Captures the observer callback so a test can fire it the way a real resize would. */
function stubResizeObserver(): {
  readonly fire: () => void;
  readonly disconnect: ReturnType<typeof vi.fn>;
} {
  const disconnect = vi.fn();
  let callback: ResizeObserverCallback | null = null;
  class RecordingResizeObserver {
    constructor(cb: ResizeObserverCallback) {
      callback = cb;
    }
    observe(): void {
      // Nothing to record - the harness drives geometry directly.
    }
    disconnect(): void {
      disconnect();
    }
  }
  vi.stubGlobal('ResizeObserver', RecordingResizeObserver);
  return {
    fire: () => {
      callback?.([], null as unknown as ResizeObserver);
    },
    disconnect,
  };
}

describe('PaneViewport scroll restore', () => {
  it('retries the restore once the ResizeObserver reports the pane grew tall enough', () => {
    // First mount stands in for "last time this pane was open": scroll it, then unmount, which
    // is what actually writes the position `positions` map the next mount reads from. Left off
    // `ResizeObserver` entirely - this mount's own retry loop is not what the test is about, and
    // sharing one spy across two independent effect lifecycles would count both.
    const first = render(
      <PaneViewport className="" scrollKey="note-1">
        content
      </PaneViewport>,
    );
    const firstPane = findPane(first.container);
    setGeometry(firstPane, { scrollHeight: 800, clientHeight: 200 });
    Object.defineProperty(firstPane, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 600,
    });
    fireEvent.scroll(firstPane);
    first.unmount();

    const { fire, disconnect } = stubResizeObserver();

    // Second mount is the one under test: content has not arrived yet, so the pane is too
    // short for 600 to be a reachable scrollTop.
    const second = render(
      <PaneViewport className="" scrollKey="note-1">
        content
      </PaneViewport>,
    );
    const pane = findPane(second.container);
    setGeometry(pane, { scrollHeight: 200, clientHeight: 200 });
    Object.defineProperty(pane, 'scrollTop', { configurable: true, writable: true, value: 0 });

    expect(pane.scrollTop).toBe(0);

    // Content grows, but still not enough room - the observer must not settle early.
    act(() => {
      setGeometry(pane, { scrollHeight: 500, clientHeight: 200 });
      fire();
    });
    expect(pane.scrollTop).toBe(0);
    expect(disconnect).not.toHaveBeenCalled();

    // Content finally grows past the saved position - the retry lands it and stops watching.
    act(() => {
      setGeometry(pane, { scrollHeight: 900, clientHeight: 200 });
      fire();
    });
    expect(pane.scrollTop).toBe(600);
    expect(disconnect).toHaveBeenCalled();

    second.unmount();
  });

  it('stops retrying once the person scrolls the pane themselves', () => {
    const first = render(
      <PaneViewport className="" scrollKey="note-2">
        content
      </PaneViewport>,
    );
    const firstPane = findPane(first.container);
    setGeometry(firstPane, { scrollHeight: 800, clientHeight: 200 });
    Object.defineProperty(firstPane, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 600,
    });
    fireEvent.scroll(firstPane);
    first.unmount();

    const { fire, disconnect } = stubResizeObserver();

    const second = render(
      <PaneViewport className="" scrollKey="note-2">
        content
      </PaneViewport>,
    );
    const pane = findPane(second.container);
    setGeometry(pane, { scrollHeight: 200, clientHeight: 200 });
    Object.defineProperty(pane, 'scrollTop', { configurable: true, writable: true, value: 0 });

    // The person scrolls away on purpose before the content ever caught up to 600.
    act(() => {
      pane.scrollTop = 50;
      fireEvent.scroll(pane);
    });
    expect(disconnect).toHaveBeenCalled();

    // Content keeps growing well past 600, but the observer already gave up - the deliberate
    // scroll must not be dragged back to the stale target.
    act(() => {
      setGeometry(pane, { scrollHeight: 900, clientHeight: 200 });
      fire();
    });
    expect(pane.scrollTop).toBe(50);

    second.unmount();
  });
});
