import { Check } from 'lucide-react';
import {
  useEffect,
  useId,
  useRef,
  type ComponentPropsWithRef,
  type ReactNode,
  type Ref,
} from 'react';

import { cn } from '../lib/cn';
import { Icon } from '../primitives/Icon';
import { disabledState, focusRing } from '../primitives/interaction';
import { Text } from '../primitives/Text';

/**
 * <Checkbox> - a tri-state toggle, drawn on the platform's own `<input type="checkbox">`.
 *
 * The native element carries the control's entire accessibility contract for free - the
 * `checkbox` role, `Space` to toggle, and a checked/unchecked/indeterminate state a screen reader
 * already knows how to announce - so it is styled in place with `appearance-none` rather than
 * hidden behind a hand-rolled `role="checkbox"` div. `<Icon icon={Check}>` sits over it only to
 * draw the mark; the input beneath is what a screen reader and the keyboard actually operate.
 *
 * **The hit area is bigger than the box.** The visible square is a compact 16px so a column of
 * checkboxes reads as fine detail, not as a row of buttons, but a target smaller than 24px is a
 * miss waiting to happen even with a mouse, so the wrapper around it claims `--control-sm` (28px)
 * regardless of how small the box inside looks. `pointer-coarse:` - Tailwind's `@media(pointer:coarse)` variant,
 * the same one `<Button>` uses - grows that wrapper to `--control-lg`, the scale's own 44px touch
 * step, once the pointer can no longer place itself precisely.
 *
 * **Indeterminate is a DOM property, not an HTML attribute.** The platform never gave
 * `indeterminate` a matching attribute, so nothing renders it from JSX; it has to be assigned onto
 * the live element after every render, which is the one thing here that needs a ref of its own
 * alongside whatever ref the caller passed in.
 *
 * **No `size` prop.** Same reasoning as `<Input>`: a checkbox that could be drawn smaller is a
 * checkbox that will be drawn under the hit-area floor somewhere it should not be.
 */

export type CheckboxProps = Omit<ComponentPropsWithRef<'input'>, 'type' | 'style'> & {
  /**
   * The visible label, rendered beside the box inside the same `<label>` so a click or tap
   * anywhere across both toggles the control. Omit only when the caller supplies its own
   * accessible name instead - an `aria-label` on a table row's selection checkbox, or a
   * `<Field>` wrapping this as its control - never to skip naming the control altogether.
   */
  readonly label?: string;

  /**
   * Neither checked nor unchecked - a parent standing for a mixed set of children, say. Purely
   * visual and announced by the platform; it does not change what `checked` reports, so a caller
   * still owns that decision independently.
   */
  readonly indeterminate?: boolean;

  /** Layout only - margin, grid placement. Never a restyle of the control. */
  readonly className?: string;
};

/** Assigns a possibly-absent, possibly-callback ref, so the internal ref this component needs for
 * `indeterminate` can share the DOM node with whatever ref the caller passed in. */
function assignRef<T>(ref: Ref<T> | undefined, node: T | null): void {
  if (typeof ref === 'function') {
    ref(node);
  } else if (ref !== null && ref !== undefined) {
    (ref as { current: T | null }).current = node;
  }
}

export function Checkbox(props: CheckboxProps): ReactNode {
  const { label, indeterminate = false, className, id, ref, disabled, ...rest } = props;

  const generatedId = useId();
  const inputId = id ?? generatedId;
  const internalRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const element = internalRef.current;
    if (element !== null) {
      element.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  const box = (
    <span
      className={cn(
        // The hit area, not the box: --control-sm clears the 24px floor for a fine pointer and
        // --control-lg is the touch step once the pointer is coarse. The visible box stays 16px.
        'relative inline-flex size-(--control-sm) shrink-0 items-center justify-center pointer-coarse:size-(--control-lg)',
        label === undefined && className,
      )}
    >
      <input
        id={inputId}
        type="checkbox"
        disabled={disabled}
        ref={(node) => {
          internalRef.current = node;
          assignRef(ref, node);
        }}
        className={cn(
          'peer size-4 shrink-0 cursor-pointer appearance-none rounded-sm border border-divider bg-background',
          'checked:border-accent-fill checked:bg-accent-fill',
          'indeterminate:border-accent-fill indeterminate:bg-accent-fill',
          'transition-colors',
          focusRing,
          disabledState,
        )}
        {...rest}
      />
      {/* Decorative: the mark the box draws once checked or indeterminate, not a second control.
          `peer-checked`/`peer-indeterminate` mirror the input's own state rather than a class this
          component would otherwise have to keep in sync by hand. */}
      <Icon
        icon={Check}
        size="sm"
        className="pointer-events-none absolute text-background opacity-0 peer-checked:opacity-100 peer-indeterminate:opacity-100"
      />
    </span>
  );

  if (label === undefined) {
    return box;
  }

  return (
    <label
      htmlFor={inputId}
      className={cn(
        'inline-flex items-center gap-2',
        disabled === true ? 'cursor-not-allowed opacity-45' : 'cursor-pointer',
        className,
      )}
    >
      {box}
      <Text variant="body" as="span">
        {label}
      </Text>
    </label>
  );
}
