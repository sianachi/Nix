import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';

import { cn } from '../lib/cn';
import { blueprintFrame } from '../primitives/Blueprint';
import { Icon } from '../primitives/Icon';
import { Text } from '../primitives/Text';
import { Button } from './Button';

/**
 * <Dialog> - a modal, on the platform's own `<dialog>`.
 *
 * Opened with `showModal()`, which is the whole reason to use the element rather than a positioned
 * div: the browser puts it in the top layer, renders a real `::backdrop`, makes the rest of the
 * document inert, and therefore traps focus and translates Escape without a keydown handler of
 * ours in the way. A hand-rolled focus trap is a list of edge cases (iframes, shadow roots, the
 * browser's own chrome, elements that become focusable while the dialog is open) that the platform
 * has already enumerated correctly, and every one it gets wrong is a keyboard user stranded behind
 * a modal.
 *
 * What is left for this component is the part the platform does not do:
 *
 * - **Focus in.** The dialog element itself takes focus, not the first button, so a screen reader
 *   announces the dialog and its title before the actions rather than starting mid-sentence at
 *   "Cancel". `initialFocus` overrides that for the dialog whose whole purpose is one field. It is
 *   a ref rather than an `autofocus` attribute because React never renders that attribute - it
 *   focuses on mount instead, and this dialog's content mounts long before it opens.
 * - **Focus back.** The invoker is remembered on open and refocused on close - including when the
 *   dialog is unmounted while open, which is how most callers close one. Focus falling to the body
 *   sends the next Tab to the top of the page, which is nowhere near where the person was.
 * - **A visible way out.** Escape and the backdrop are invisible affordances; the close control in
 *   the corner is the one a pointer user can see. It is not optional, because `actions` is.
 *
 * **Open is the caller's, not the element's.** Escape and backdrop clicks are intercepted and
 * reported through `onClose` rather than allowed to close the element, so the DOM can never be
 * closed while the prop still says open. Whoever owns the flag decides when it flips - which is
 * also what lets a dialog refuse to close over unsaved work.
 *
 * **When not to use this.** A disclosure that must render as a sibling of an ancestor the user
 * still needs on screen - a header with its own toggle and search, say - cannot use `showModal()`:
 * the top layer is anchored to the viewport, and covering the viewport is precisely what such a
 * disclosure exists not to do. `apps/web/src/app/sidebar-drawer.tsx` is that exception, applying
 * `inert` to what it covers instead of trapping focus; see ADR-0029 for the full reasoning and the
 * Escape-layering convention a non-modal overlay of this kind has to follow.
 */

export interface DialogProps {
  /** Whether the modal is showing. The caller owns it; the element only reflects it. */
  readonly open: boolean;

  /**
   * The modal's title, and its accessible name. Required: a dialog announced only as "dialog"
   * gives a screen reader user nothing to decide with.
   */
  readonly title: string;

  /**
   * Asked to close - by Escape, by the backdrop, or by the close control. Whether that actually
   * closes anything is the caller's decision.
   */
  readonly onClose: () => void;

  /** The body. */
  readonly children: ReactNode;

  /**
   * The actions, laid out along the trailing edge. Buttons, in reading order: the primary action
   * last, since it is the one the eye lands on before it leaves the box.
   */
  readonly actions?: ReactNode;

  /** Names the close control. Overridable because "Close" is not always the honest word for it. */
  readonly closeLabel?: string;

  /**
   * Where focus should land instead of on the dialog itself - the one field of a rename dialog,
   * say. Ignored if the element is not there when the dialog opens, which is the safe failure: the
   * dialog keeps the focus rather than leaving it behind on the page.
   */
  readonly initialFocus?: RefObject<HTMLElement | null>;

  /** Layout only - width, margin. Never a restyle of the frame or the backdrop. */
  readonly className?: string;
}

export function Dialog(props: DialogProps): ReactNode {
  const {
    open,
    title,
    onClose,
    children,
    actions,
    closeLabel = 'Close',
    initialFocus,
    className,
  } = props;

  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const invokerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const element = dialogRef.current;
    if (element === null) {
      return;
    }

    if (open) {
      if (!element.open) {
        const active = document.activeElement;
        invokerRef.current = active instanceof HTMLElement ? active : null;
        element.showModal();
        (initialFocus?.current ?? element).focus();
      }
      return;
    }

    if (element.open) {
      element.close();
    }

    const invoker = invokerRef.current;
    invokerRef.current = null;
    if (invoker?.isConnected === true) {
      invoker.focus();
    }
    // `initialFocus` is a ref, so it is stable and only `open` ever re-runs this in practice; it is
    // listed because the effect reads it, not because it moves.
  }, [open, initialFocus]);

  useEffect(() => {
    // The ref object, not its contents: the cleanup below runs after the component is gone, and
    // reading `invokerRef.current` at that point is only sound because the ref object it belongs to
    // was captured while the component was alive.
    const invokers = invokerRef;

    return () => {
      const invoker = invokers.current;
      if (invoker?.isConnected === true) {
        invoker.focus();
      }
    };
  }, []);

  useEffect(() => {
    const element = dialogRef.current;
    if (element === null) {
      return;
    }

    // The listeners are attached to the element rather than written as JSX handlers because both
    // of them need the native event's target: a backdrop click is dispatched at the `<dialog>`
    // itself, and telling it apart from a click on the content is the whole test.
    const onCancel = (event: Event): void => {
      event.preventDefault();
      onClose();
    };

    // A press that starts inside and finishes on the backdrop is a text selection that overshot,
    // not a dismissal. Both ends of the press have to land outside before the modal closes.
    let pressStartedOnBackdrop = false;

    const onPointerDown = (event: MouseEvent): void => {
      pressStartedOnBackdrop = event.target === element;
    };

    const onClick = (event: MouseEvent): void => {
      const outside = pressStartedOnBackdrop && event.target === element;
      pressStartedOnBackdrop = false;
      if (outside) {
        onClose();
      }
    };

    element.addEventListener('cancel', onCancel);
    element.addEventListener('mousedown', onPointerDown);
    element.addEventListener('click', onClick);

    return () => {
      element.removeEventListener('cancel', onCancel);
      element.removeEventListener('mousedown', onPointerDown);
      element.removeEventListener('click', onClick);
    };
  }, [onClose]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      // Focus has to land somewhere inside on open, and the element is only a landing spot - there
      // is nothing here to operate, so the 2px accent ring every control wears would be drawn
      // around an entire modal to indicate nothing. The frame and the backdrop already say where
      // the boundary is.
      tabIndex={-1}
      className={cn(
        blueprintFrame,
        // Preflight zeroes the margin a modal `<dialog>` relies on to centre itself.
        'm-auto p-0 shadow-lg outline-none',
        // Opaque, unlike a card: a transparent line drawing over live content is unreadable, and
        // this is the one place in the system where a surface has to sit on top of another.
        'bg-background text-foreground',
        // design-token-exempt: 560px is a comfortable reading measure for a modal, not a step on
        // any scale - the same category as the shell's sidebar and panel widths, which
        // apps/web/src/app/layout.ts keeps out of the token sheet for the same reason. Making it a
        // token would have the design system carry one number used in one place, and the gutter
        // beside it already comes from `--spacing`.
        'w-[min(560px,calc(100vw-var(--spacing)*8))]',
        // The scrim is the one colour in the library that must *not* follow the ground. It exists
        // to dim what is behind the modal, and an ink wash of `--color-foreground` stops doing
        // that the moment the foreground is paper: on the dark ground it would be a light veil
        // that brightens the page instead of pushing it back. The neutral ramp does not move
        // between grounds (ADR-0008), so its deepest step is the one thing here that darkens on
        // both - which is why this is a ramp step rather than a role. It is one of exactly two:
        // the other is `<Duotone>`, whose two tones must not move for the same kind of reason.
        'backdrop:bg-neutral-900/40',
        className,
      )}
    >
      {/* The scroll lives here rather than on the element itself so a long body scrolls inside the
          frame, and the registration marks - which sit 6px outside it - are never clipped. */}
      <div className="flex max-h-[80vh] flex-col gap-4 overflow-y-auto p-6">
        <div className="flex items-start gap-4">
          {/* h2, not a caller's choice: a modal is its own document for the duration, so its title
              starts a heading outline rather than joining the page's. */}
          <Text id={titleId} variant="h3" as="h2" className="flex-1">
            {title}
          </Text>
          <Button variant="icon" aria-label={closeLabel} onClick={onClose}>
            <Icon icon={X} size="sm" />
          </Button>
        </div>

        {children}

        {actions === undefined ? null : (
          <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>
        )}
      </div>
    </dialog>
  );
}
