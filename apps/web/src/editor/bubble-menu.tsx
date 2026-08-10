import { Icon } from '@nix/ui';
import type { TextColor } from '@nix/editor-schema';
import type { Editor } from '@tiptap/react';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Baseline } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * The selection bubble menu: a small toolbar that appears over selected text.
 *
 * Today it carries one group - the text colour - because colour is the one formatting decision
 * with no keyboard shortcut and no input rule; everything else the main toolbar offers is
 * reachable without leaving the keys. More groups earn their place here by the same argument,
 * one at a time.
 *
 * **The same shape as the slash menu, deliberately.** The document's selection is the source of
 * truth, read back out of the editor on every transaction - and on scroll and resize too,
 * because the box is placed in viewport coordinates against text that moves without a
 * transaction: the editor scrolls inside its own overflow container. Focus stays in the editor
 * for pointer users (mousedown on the menu is swallowed before it can blur the text); keyboard
 * users Tab to it, because the menu sits after the editable region in the DOM. It costs one tab
 * stop, not three: `role="toolbar"` promises arrow-key navigation, so the focus roves between
 * the buttons rather than the Tab key walking them.
 *
 * The vendor's bubble-menu plugin was configured but never given an element - it draws nothing
 * without one - and wiring it up would have bought floating-ui positioning at the price of a
 * second show/hide model to keep in step with this file's own.
 *
 * **The colours are token roles, not values.** Each button applies a name from the schema's
 * closed set; what the name looks like is decided by `prose.ts` against the design tokens at
 * render, which is what keeps a stored document legible on both grounds. `default` clears the
 * mark rather than writing a literal "ordinary text" colour into the document - the command in
 * `@nix/editor-schema` owns that rule.
 */

interface ColorOption {
  readonly color: TextColor;
  /** The visible word. Colour alone cannot tell accent from muted - both are greys on a mono sheet. */
  readonly name: string;
  /** The accessible name, which contains the visible word so voice control can reach it. */
  readonly label: string;
  /** The role the button renders in - the honest preview of what the choice does. */
  readonly swatchClass: string;
}

const COLOR_OPTIONS: readonly ColorOption[] = [
  { color: 'default', name: 'Default', label: 'Default colour', swatchClass: 'text-foreground' },
  // The same role the applied mark renders with (`prose.ts`), so the button shows exactly what
  // the text will become - accent-text rather than the base accent, because this is body-size
  // text and the base ramp step does not carry body-size contrast.
  { color: 'accent', name: 'Accent', label: 'Accent colour', swatchClass: 'text-accent-text' },
  { color: 'muted', name: 'Muted', label: 'Muted colour', swatchClass: 'text-muted' },
];

/**
 * The viewport room the menu needs above a selection: its own row plus the gap. A selection
 * nearer the top edge than this gets the menu underneath instead, where there is room - the
 * alternative is a toolbar drawn off-screen for anybody colouring their first line.
 */
const MENU_CLEARANCE = 48;

/**
 * Whether a range holds any text at all.
 *
 * `textBetween` would answer the same question by building the string first: on a select-all of
 * a long note that is the whole document materialised - measured at 131 KB per call, and 12.5 MB
 * of garbage across a hundred scroll events - to decide a yes or a no. This stops at the first
 * text node it finds. A bare node selection still reads as "no text", which is the distinction
 * the caller depends on.
 */
function hasText(doc: ProseMirrorNode, from: number, to: number): boolean {
  let found = false;

  doc.nodesBetween(from, to, (node, pos) => {
    if (found) {
      return false;
    }
    // The node has to overlap the range, not merely be visited: `nodesBetween` hands over the
    // ancestors of the endpoints too, and a text node touching the boundary contributes nothing.
    if (node.isText && Math.min(to, pos + node.nodeSize) > Math.max(from, pos)) {
      found = true;
      return false;
    }
    return true;
  });

  return found;
}

/** Where the menu sits, and which selection it belongs to. */
interface MenuPlacement {
  readonly left: number;
  readonly top: number;
  /** Flipped under the selection, because the viewport had no room above it. */
  readonly below: boolean;
  /** The selected range, so a dismissal is of this selection rather than of all of them. */
  readonly from: number;
  readonly to: number;
}

export function BubbleMenu({ editor }: { readonly editor: Editor }): ReactNode {
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);

  // The selection Escape dismissed the menu over. Selecting something else opens it again.
  const [dismissed, setDismissed] = useState<{ readonly from: number; readonly to: number } | null>(
    null,
  );

  // Which button holds the toolbar's one tab stop. An index rather than a colour, so the arrow
  // keys can walk the row without caring what is on it.
  const [focusIndex, setFocusIndex] = useState(0);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const container = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // The frame a coalesced read is already booked for, so a burst of scroll events costs one
    // measurement rather than one each. Without it a hundred scroll events were a hundred
    // renders, each forcing layout through `coordsAtPos` - and the listener is deliberately
    // capture-phase on the window, so *every* scrolling element on the page reaches it.
    let frame: number | null = null;

    // A fresh object on every transaction, not only when the coordinates move: a colour applied
    // to a standing selection changes no coordinate, and the buttons' pressed state has to
    // re-render from the new document all the same.
    function readSelection(): void {
      if (editor.isDestroyed) {
        setPlacement(null);
        return;
      }

      const { state } = editor;
      const { from, to, empty } = state.selection;

      // Only a selection that actually holds text. An empty selection is a caret; a non-empty
      // one over no text (a bare node selection, a table cell boundary) has nothing this menu's
      // commands could colour.
      if (empty || !hasText(state.doc, from, to)) {
        setPlacement(null);
        return;
      }

      const coords = editor.view.coordsAtPos(from);
      const below = coords.top < MENU_CLEARANCE;

      setPlacement({
        left: coords.left,
        top: below ? coords.bottom : coords.top,
        below,
        from,
        to,
      });
    }

    // Closed when focus truly leaves the editing surface. Focus moving *into* the menu is not
    // leaving - that is a keyboard user arriving - so the blur is ignored when its destination
    // sits inside the menu's own element.
    function onBlur({ event }: { readonly event: FocusEvent }): void {
      const destination = event.relatedTarget;
      if (destination instanceof Node && container.current?.contains(destination) === true) {
        return;
      }
      setPlacement(null);
    }

    /** One read per frame, however many events arrive in it. */
    function scheduleRead(): void {
      if (frame !== null) {
        return;
      }
      frame = requestAnimationFrame(() => {
        frame = null;
        readSelection();
      });
    }

    readSelection();
    editor.on('transaction', readSelection);
    editor.on('blur', onBlur);

    // Capture, because a scroll event does not bubble out of the element that scrolled - and
    // the editor's own scroller is exactly the one that moves this text. Passive, because the
    // handler only ever books a frame.
    window.addEventListener('scroll', scheduleRead, { capture: true, passive: true });
    window.addEventListener('resize', scheduleRead);

    return () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
      editor.off('transaction', readSelection);
      editor.off('blur', onBlur);
      window.removeEventListener('scroll', scheduleRead, { capture: true });
      window.removeEventListener('resize', scheduleRead);
    };
  }, [editor]);

  // After the hooks, which have to run unconditionally. `useEditor` tears an editor down and
  // builds another whenever its dependencies change - strict mode does it on every mount - and
  // a render landing in that gap must not reach `can()` on an editor whose command manager is
  // already null. `toolbar.tsx` documents the crash this guard exists for.
  if (editor.isDestroyed) {
    return null;
  }

  const open =
    placement !== null &&
    !(dismissed !== null && dismissed.from === placement.from && dismissed.to === placement.to);

  // Nothing below this line is worth computing for a menu that draws nothing - and a dismissed
  // menu is exactly that for as long as the selection it was dismissed over stands: `placement`
  // stays set, so every transaction and every scroll still re-renders this component. The live
  // region stays mounted, because a region that comes and goes is one a screen reader may not
  // be watching when the menu next opens.
  //
  // The fragment matches the open branch's shape so React reconciles the live region as the
  // same element across both, rather than tearing it down and inserting a fresh one: a region
  // that has only just appeared is one a screen reader may not yet be watching.
  if (!open) {
    return (
      <>
        <p aria-live="polite" className="sr-only" />
      </>
    );
  }

  // Whether each command can run where the selection is. Marks are not admitted inside a code
  // block or inline code, and a button that would silently do nothing is worse than one that
  // says it cannot.
  //
  // One `can()` for all three probes: each call builds a proxy over every registered command
  // and each invocation re-evaluates that map, so three calls was about 700 closures a render
  // (measured 66-136 microseconds). Sharing it is safe because `can()` captures one transaction
  // and every probe through it runs undispatched.
  const can = editor.can();
  const runnable = COLOR_OPTIONS.map((option) => can.setTextColor(option.color));

  // The tab stop has to sit on a button that can actually be used.
  const firstRunnable = runnable.indexOf(true);
  const tabStop = runnable[focusIndex] === true ? focusIndex : firstRunnable;

  /** Moves the roving focus along by `step` buttons, passing over any that cannot run. */
  function rove(from: number, step: number): void {
    const count = COLOR_OPTIONS.length;
    for (let i = 1; i <= count; i += 1) {
      const next = (((from + step * i) % count) + count) % count;
      if (runnable[next] === true) {
        setFocusIndex(next);
        buttons.current[next]?.focus();
        return;
      }
    }
  }

  // Whether *any* of the selection carries the mark - a different question from `isActive`'s
  // "does all of it carry this colour". A selection spanning coloured and uncoloured text is
  // neither default nor accent, and saying "Default colour, pressed" over it would be a lie.
  // Mixed presses nothing.
  const markType = editor.state.schema.marks.textColor;
  const anyMark =
    markType !== undefined && editor.state.doc.rangeHasMark(placement.from, placement.to, markType);

  const activeColor = COLOR_OPTIONS.filter((option) => option.color !== 'default').find((option) =>
    editor.isActive('textColor', { text: option.color }),
  )?.color;

  return (
    <>
      {/* Announced when the menu appears. It opens away from the focus, so without this a
          screen-reader user who has just selected text has no way to know the options exist. */}
      <p aria-live="polite" className="sr-only">
        Text colour options available
      </p>

      <div
        ref={container}
        role="toolbar"
        aria-label="Text colour"
        aria-orientation="horizontal"
        // Positioned against the selection in viewport coordinates, re-read on scroll and on
        // resize above, so it stays with its text rather than with the page.
        style={{ left: placement.left, top: placement.top }} // design-token-exempt: a selection's position is a runtime measurement, not a scale step.
        className={[
          'fixed z-20 flex items-center gap-0.5 rounded-md bg-surface p-1 shadow-md',
          placement.below ? 'mt-2' : '-mt-2 -translate-y-full',
        ].join(' ')}
        // Swallowed before the browser can move focus: a pointer press on a menu button must
        // not blur the editor, or the selection being coloured would collapse under the click.
        onMouseDown={(event) => {
          event.preventDefault();
        }}
        onKeyDown={(event) => {
          // Escape closes this layer and puts the caret back in the text it came from. It
          // stops there: the innermost open layer wins the key, which is the convention
          // `slash-menu.tsx` and `command-palette.tsx` document.
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setDismissed({ from: placement.from, to: placement.to });
            editor.commands.focus();
            return;
          }

          // The roving tab stop that `role="toolbar"` promises: the arrows walk the row, Home
          // and End jump to its ends, and Tab stays one stop through the whole toolbar.
          if (event.key === 'ArrowRight') {
            event.preventDefault();
            rove(tabStop, 1);
          } else if (event.key === 'ArrowLeft') {
            event.preventDefault();
            rove(tabStop, -1);
          } else if (event.key === 'Home') {
            event.preventDefault();
            rove(COLOR_OPTIONS.length - 1, 1);
          } else if (event.key === 'End') {
            event.preventDefault();
            rove(0, -1);
          }
        }}
      >
        {COLOR_OPTIONS.map((option, index) => {
          const active = option.color === 'default' ? !anyMark : activeColor === option.color;
          const disabled = runnable[index] !== true;

          return (
            <button
              key={option.color}
              ref={(element) => {
                buttons.current[index] = element;
              }}
              type="button"
              aria-label={option.label}
              title={option.label}
              aria-pressed={active}
              disabled={disabled}
              tabIndex={index === tabStop ? 0 : -1}
              onClick={() => {
                editor.chain().focus().setTextColor(option.color).run();
              }}
              className={[
                'flex h-7 items-center gap-1 rounded-sm px-1.5 text-xs',
                'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
                option.swatchClass,
                disabled
                  ? 'cursor-not-allowed opacity-40'
                  : active
                    ? 'bg-accent/18'
                    : 'hover:bg-foreground/7',
              ].join(' ')}
            >
              <Icon icon={Baseline} size="sm" />
              {option.name}
            </button>
          );
        })}
      </div>
    </>
  );
}
