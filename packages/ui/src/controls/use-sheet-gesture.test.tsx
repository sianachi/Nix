import { act, render, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { GestureConfig, GestureDetail } from '@ionic/core';
import { useSheetGesture } from './use-sheet-gesture';

const mocks = vi.hoisted(() => ({ create: vi.fn(), enable: vi.fn(), destroy: vi.fn() }));
vi.mock('@ionic/core/components', () => ({ createGesture: mocks.create }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
function Harness({ close }: { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const handle = useRef<HTMLButtonElement>(null);
  useSheetGesture(dialog, handle, true, close);
  return (
    <dialog ref={dialog} open>
      <button ref={handle}>Dismiss sheet</button>
    </dialog>
  );
}
it('recognizes a downward swipe, retains caller ownership, and destroys the gesture on unmount', async () => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  let config: GestureConfig | undefined;
  mocks.create.mockImplementation((value: GestureConfig) => {
    config = value;
    return { enable: mocks.enable, destroy: mocks.destroy };
  });
  const close = vi.fn();
  const view = render(<Harness close={close} />);
  await waitFor(() => {
    expect(mocks.enable).toHaveBeenCalledWith(true);
  });
  const dialog = view.getByRole('dialog');
  vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({ height: 400 } as DOMRect);
  act(() => {
    config?.onMove?.({ deltaY: 60 } as GestureDetail);
  });
  expect(dialog.style.transform).toBe('translateY(60px)');
  act(() => {
    config?.onEnd?.({ deltaY: 60, velocityY: 0 } as GestureDetail);
  });
  expect(close).not.toHaveBeenCalled();
  act(() => {
    config?.onEnd?.({ deltaY: 120, velocityY: 0 } as GestureDetail);
  });
  expect(close).toHaveBeenCalledOnce();
  expect(dialog).toHaveAttribute('open');
  expect(dialog.style.transform).toBe('');
  view.unmount();
  expect(mocks.destroy).toHaveBeenCalledOnce();
});
it('disables sheet gestures on desktop', async () => {
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  mocks.create.mockReturnValue({ enable: mocks.enable, destroy: mocks.destroy });
  render(<Harness close={vi.fn()} />);
  await waitFor(() => {
    expect(mocks.enable).toHaveBeenCalledWith(false);
  });
});
