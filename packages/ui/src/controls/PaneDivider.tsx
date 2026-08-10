import { cva } from 'class-variance-authority';
import { useRef, type ReactNode } from 'react';

import { cn } from '../lib/cn';
import { dragHandleLineStates, focusRing } from '../primitives/interaction';

/**
 * <PaneDivider> - the handle between two panes.
 *
 * **Keyboard first, pointer second.** A divider that can only be dragged is a layout control for
 * only some people, and the answer here is that every gesture has a key. `role="separator"` with a
 * `tabindex` is the ARIA window-splitter pattern, and it is what makes the value announceable as
 * it changes rather than silently.
 *
 * **`aria-orientation` names the divider, not the arrangement.** Panes side by side are separated
 * by a *vertical* divider, so a vertical split reports `vertical` - which is also the axis the
 * left and right arrows move it along.
 *
 * **The value model is a share of a pair.** The divider trades space between exactly the two
 * elements either side of it; a handle that moves one edge of a fixed-width region and reports
 * pixels is a different control with a different value model, which is why the workspace tree's
 * own divider is deliberately not this component.
 *
 * **It must be rendered as the immediate sibling of both elements it resizes**, because a drag
 * measures the pair through `previousElementSibling` and `nextElementSibling` rather than being
 * told their geometry. Placed anywhere else it still keys and still announces, and silently
 * cannot be dragged - so a misplacement says so in development. See `PaneDividerProps.before`.
 */

/** The axis of the drawn line: vertical between panes side by side. */
export type PaneDividerOrientation = 'vertical' | 'horizontal';

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

/**
 * A hairline that becomes a grabbable band. The visible rule is the divider colour the rest of
 * the shell uses; the padding either side is hit area, which is why the element is wider than the
 * line it draws. The pseudo-element widens what a pointer has to hit to an 8px band with a 24px
 * target, without widening what the eye sees or what the layout gives up - 8px alone is under
 * WCAG 2.2's 24px minimum, and a divider is exactly the control a shaky hand misses.
 */
const handleVariants = cva(cn('group relative shrink-0 touch-none', focusRing), {
  variants: {
    orientation: {
      vertical: 'w-2 cursor-col-resize before:absolute before:inset-y-0 before:-inset-x-2',
      horizontal: 'h-2 cursor-row-resize before:absolute before:inset-x-0 before:-inset-y-2',
    },
  },
});

/**
 * The drawn mark inside the band, in the library's own drag-handle states rather than a local
 * lookalike - including the deeper pressed step while a drag is live, which the handle root
 * declares as `data-dragging` for the duration. See `dragHandleLineStates`.
 *
 * A hairline (`w-px`/`h-px`), which is the weight every drag handle in the product draws.
 */
const lineVariants = cva(
  cn('pointer-events-none absolute bg-divider transition-colors', dragHandleLineStates),
  {
    variants: {
      orientation: {
        vertical: 'inset-y-0 left-1/2 w-px -translate-x-1/2',
        horizontal: 'inset-x-0 top-1/2 h-px -translate-y-1/2',
      },
    },
  },
);

export interface PaneDividerProps {
  /** Which way the panes are arranged. A vertical split puts a vertical divider between them. */
  readonly orientation: PaneDividerOrientation;

  /**
   * The pair this divider sits between: their grow factors, which need not sum to anything.
   *
   * **The two elements they describe must be this component's immediate siblings** - a drag
   * measures the pair through `previousElementSibling` and `nextElementSibling`. A divider
   * rendered anywhere else keys and announces correctly but cannot be dragged.
   */
  readonly before: number;
  readonly after: number;

  /**
   * What the two neighbours are called: the one before this handle and the one after.
   *
   * They name the control ("Resize Spec and Notes") and give the announced value a subject
   * ("70 percent to Spec"), which is what turns a bare "separator, 70" into a sentence.
   */
  readonly beforeName: string;
  readonly afterName: string;

  /**
   * The id of the pane this handle resizes, rendered as `aria-controls`.
   *
   * Required, because the APG's window-splitter pattern is a value *about something*: without the
   * reference, "70 percent to Spec" is a number whose subject exists only in the label's prose,
   * and assistive technology has no way to move from the handle to the region it moves.
   */
  readonly controls: string;

  /**
   * The control's accessible name, when "Resize <before> and <after>" is not the right sentence.
   *
   * Composed from the two names by default, so the ordinary case cannot drift out of step with
   * the panes it sits between - which it did when every caller assembled the string itself.
   */
  readonly label?: string;

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

export function PaneDivider({
  orientation,
  before,
  after,
  beforeName,
  afterName,
  controls,
  label = `Resize ${beforeName} and ${afterName}`,
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
      // Silent here would mean a handle that keys and announces perfectly and does nothing at all
      // under a pointer - the hardest kind of bug to see, because two thirds of the control still
      // work. Said once, in development only, where the caller can act on it.
      //
      // Optional chaining because this package ships raw source: `import.meta.env` is filled in
      // by whichever bundler the consumer runs, and every consumer today is Vite or Vitest. One
      // that is not would otherwise throw a TypeError at exactly the moment the warning was
      // meant to help.
      //
      // Justification: `vite/client` types `import.meta.env` as always present, which is true of
      // a Vite build and is a claim about the *bundler*, not about this source file - the rule
      // is reading a type that cannot know who compiles this package.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (import.meta.env?.DEV) {
        console.warn(
          'PaneDivider: expected the two elements it resizes as its immediate siblings.',
        );
      }
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

    // What the drawn line's pressed step hangs off. A data attribute rather than `:active`,
    // because a live drag routes the pointer through a capture overlay that `:active` cannot see -
    // see `dragHandleLineStates`.
    handle.dataset.dragging = 'true';

    function stopTracking(): void {
      delete handle.dataset.dragging;
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
      // What the handle moves, so the value has a programmatic subject and not only a prose one.
      aria-controls={controls}
      // Rounded to whole percent: the value is a position a hand or an arrow key put the handle
      // at, and a screen reader reading "49.8 percent" of a drag is reporting precision the
      // gesture never had. The shares the callbacks carry are the unrounded truth.
      aria-valuenow={share}
      // A bare "50" is announced as a number with no units and no subject.
      aria-valuetext={`${String(share)} percent to ${beforeName}`}
      aria-valuemin={MINIMUM_SHARE}
      aria-valuemax={MAXIMUM_SHARE}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      className={handleVariants({ orientation })}
    >
      <span aria-hidden="true" className={lineVariants({ orientation })} />
    </div>
  );
  /* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
}
