import { focusRing } from '@nix/ui';
import { useRef, type ReactNode } from 'react';

import type { SplitOrientation } from './pane-params';

/**
 * The smallest share a pane may be squeezed to, as a percentage of the pair either side of a
 * divider.
 *
 * Not a taste number: below about a sixth of the pair, a pane is narrower than its own header
 * controls and the thing it is showing stops being readable rather than merely cramped. Bounding
 * the drag is also what makes the keyboard bounds (`Home` and `End`) mean something.
 */
const MINIMUM_SHARE = 15;

const MAXIMUM_SHARE = 100 - MINIMUM_SHARE;

/** How far one arrow press moves the divider, and how far one with Shift held moves it. */
const STEP = 1;
const COARSE_STEP = 10;

export interface PaneDividerProps {
  /** Which way the panes are arranged. A vertical split puts a vertical divider between them. */
  readonly orientation: SplitOrientation;

  /** The pair this divider sits between: their grow factors, which need not sum to anything. */
  readonly before: number;
  readonly after: number;

  /** Names the two panes, so the control says what it resizes rather than "separator". */
  readonly label: string;

  /** The pane before this handle, by name, so the value has a subject when it is announced. */
  readonly firstName: string;

  /**
   * Called continuously during a drag with the pair's new shares.
   *
   * The group is expected to apply these without a React render - a state update per pointer
   * event would re-render two whole editors sixty times a second.
   */
  readonly onPreview: (before: number, after: number) => void;

  /** Called once the value has settled: on pointer release, or immediately on a key press. */
  readonly onCommit: (before: number, after: number) => void;
}

/**
 * The handle between two panes.
 *
 * **Keyboard first, pointer second.** A divider that can only be dragged is a layout control for
 * only some people, which is the same objection ADR-0009 recorded against a drop zone that existed
 * only for a pointer - and the answer here is the same shape: every gesture has a key.
 * `role="separator"` with a `tabindex` is the ARIA window-splitter pattern, and it is what makes
 * the value announceable as it changes rather than silently.
 *
 * **`aria-orientation` names the divider, not the arrangement.** Panes side by side are separated
 * by a *vertical* divider, so a vertical split reports `vertical` - which is also the axis the
 * left and right arrows move it along.
 */
export function PaneDivider({
  orientation,
  before,
  after,
  label,
  firstName,
  onPreview,
  onCommit,
}: PaneDividerProps): ReactNode {
  const ref = useRef<HTMLDivElement>(null);

  // Where the handle was before it was evened up, so the same key puts it back. A ref rather than
  // state because nothing renders from it - it only has to survive between two key presses.
  const beforeEvenRef = useRef<number | null>(null);

  const total = before + after;
  // Expressed as the first pane's share of the pair rather than of the whole group, so the number
  // a screen reader announces is about the two panes this handle actually moves.
  const share = total > 0 ? Math.round((before / total) * 100) : 50;

  function applyShare(next: number, commit: boolean): void {
    const clamped = Math.min(MAXIMUM_SHARE, Math.max(MINIMUM_SHARE, next));
    const nextBefore = (total * clamped) / 100;
    const nextAfter = total - nextBefore;

    if (commit) {
      onCommit(nextBefore, nextAfter);
    } else {
      onPreview(nextBefore, nextAfter);
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const vertical = orientation === 'vertical';
    const decrease = vertical ? 'ArrowLeft' : 'ArrowUp';
    const increase = vertical ? 'ArrowRight' : 'ArrowDown';
    const step = event.shiftKey ? COARSE_STEP : STEP;

    if (event.key === decrease) {
      event.preventDefault();
      applyShare(share - step, true);
      return;
    }

    if (event.key === increase) {
      event.preventDefault();
      applyShare(share + step, true);
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      applyShare(MINIMUM_SHARE, true);
      return;
    }

    if (event.key === 'End') {
      event.preventDefault();
      applyShare(MAXIMUM_SHARE, true);
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      // Even, and back to wherever it was. The one gesture a pointer does not offer at all - a
      // drag reaches exactly 50% only by aiming at it - so it has to be undoable by the same key,
      // and undoing to a bound nobody chose would not be an undo.
      event.preventDefault();

      if (share === 50) {
        const restored = beforeEvenRef.current;
        applyShare(restored ?? MAXIMUM_SHARE, true);
        beforeEvenRef.current = null;
        return;
      }

      beforeEvenRef.current = share;
      applyShare(50, true);
    }
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    // Only the primary button. Without this, a right-click to open a context menu starts a drag
    // that nothing ends.
    if (event.button !== 0) {
      return;
    }

    const element = ref.current;
    const first = element?.previousElementSibling;
    const second = element?.nextElementSibling;
    if (!element || !first || !second) {
      return;
    }

    // Capture, so the drag survives the pointer leaving the handle - which it does immediately,
    // because the handle is a few pixels wide and a hand is not that steady.
    element.setPointerCapture(event.pointerId);

    // The pair's own region, measured rather than derived. Working back from the grow factors
    // would mean reconstructing where a third pane starts; the two elements either side already
    // know, and asking them is exact.
    const vertical = orientation === 'vertical';
    const firstRect = first.getBoundingClientRect();
    const secondRect = second.getBoundingClientRect();
    const pairStart = vertical ? firstRect.left : firstRect.top;
    const pairLength = (vertical ? secondRect.right : secondRect.bottom) - pairStart;

    function shareAt(clientX: number, clientY: number): number {
      if (pairLength <= 0) {
        return share;
      }
      return (((vertical ? clientX : clientY) - pairStart) / pairLength) * 100;
    }

    function onPointerMove(moveEvent: PointerEvent): void {
      applyShare(shareAt(moveEvent.clientX, moveEvent.clientY), false);
    }

    // Narrowed once, so the listeners below close over a value TypeScript knows is an element -
    // the `ref.current` they would otherwise read is nullable at every one of them.
    const handle = element;

    function stopTracking(): void {
      handle.removeEventListener('pointermove', onPointerMove);
      handle.removeEventListener('pointerup', onPointerUp);
      handle.removeEventListener('pointercancel', onPointerCancel);
    }

    function onPointerUp(upEvent: PointerEvent): void {
      applyShare(shareAt(upEvent.clientX, upEvent.clientY), true);
      stopTracking();
    }

    function onPointerCancel(): void {
      // A gesture the system took away - an incoming call, a back-swipe, a rejected palm - has to
      // put the layout back where it started rather than commit wherever the pointer happened to
      // be. `pointercancel` also carries stale or zero coordinates in some engines, so committing
      // from it can slam the split to a bound nobody dragged to.
      onPreview(before, after);
      stopTracking();
    }

    handle.addEventListener('pointermove', onPointerMove);
    handle.addEventListener('pointerup', onPointerUp);
    handle.addEventListener('pointercancel', onPointerCancel);
  }

  const vertical = orientation === 'vertical';

  // Justification: `jsx-a11y` classes `separator` as non-interactive, which is true of the
  // decorative kind and false of this one. ARIA defines a *focusable* separator as the window
  // splitter widget - a range control with a value, which is exactly what this is and why it
  // carries `aria-valuenow`, `aria-valuemin` and `aria-valuemax`. The rule cannot tell the two
  // apart, and the element it would steer this towards, a `<button>`, has no way to report a
  // value at all.
  /* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
  return (
    <div
      ref={ref}
      role="separator"
      tabIndex={0}
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={share}
      // A bare "50" is announced as a number with no units and no subject.
      aria-valuetext={`${String(share)} percent to ${firstName}`}
      aria-valuemin={MINIMUM_SHARE}
      aria-valuemax={MAXIMUM_SHARE}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      className={[
        // A hairline that becomes a grabbable band. The visible rule is the divider colour the
        // rest of the shell uses; the padding either side is hit area, which is why the element
        // is wider than the line it draws.
        'group relative shrink-0 touch-none',
        // An 8px band with a 24px target. The pseudo-element widens what a pointer has to hit
        // without widening what the eye sees or what the layout gives up - 8px alone is under
        // WCAG 2.2's 24px minimum, and a divider is exactly the control a shaky hand misses.
        vertical
          ? 'w-2 cursor-col-resize before:absolute before:inset-y-0 before:-inset-x-2'
          : 'h-2 cursor-row-resize before:absolute before:inset-x-0 before:-inset-y-2',
        focusRing,
      ].join(' ')}
    >
      <span
        aria-hidden="true"
        className={[
          'pointer-events-none absolute bg-divider transition-colors',
          'group-hover:bg-accent group-focus-visible:bg-accent',
          vertical
            ? 'inset-y-0 left-1/2 w-px -translate-x-1/2'
            : 'inset-x-0 top-1/2 h-px -translate-y-1/2',
        ].join(' ')}
      />
    </div>
  );
  /* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
}
