import { Button, Text, cn, focusRing, inkWashStates } from '@nix/ui';
import type { ReactNode } from 'react';
import { formatMoney, formatMoneyRound, formatMonth, shiftMonth } from './money';

/**
 * A piece of text that is also a button: a line's name, a transaction's description. The dotted
 * rule beneath says at rest that it opens something; the wash on hover and the ring on focus say
 * the same for pointer and keyboard.
 */
export const editableTextButton = cn(
  '-mx-1 rounded px-1 py-0.5 text-left',
  'underline decoration-dotted decoration-divider underline-offset-4',
  inkWashStates,
  focusRing,
);

/** A figure, printed; never computed here. */
export function Money({
  amount,
  currency,
  signed = false,
  round = false,
}: {
  readonly amount: number;
  readonly currency: string;
  readonly signed?: boolean;
  readonly round?: boolean;
}): ReactNode {
  return (
    <span className="tabular-nums">
      {round ? formatMoneyRound(amount, currency) : formatMoney(amount, currency, { signed })}
    </span>
  );
}

/** A headline number with a label above and, optionally, a line of context beneath. */
export function Tile({
  label,
  value,
  caption,
  children,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly caption?: ReactNode;
  readonly children?: ReactNode;
}): ReactNode {
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-surface-raised p-3">
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Text as="p" variant="h4">
        {value}
      </Text>
      {caption === undefined ? null : (
        <Text variant="bodySmall" tone="muted">
          {caption}
        </Text>
      )}
      {children}
    </div>
  );
}

/** A proportion, drawn; the number beside it is what a reader relies on. */
export function Meter({
  fraction,
  label,
}: {
  readonly fraction: number;
  readonly label: string;
}): ReactNode {
  const clamped = Math.max(0, Math.min(1, fraction));
  const width = `${String(Math.round(clamped * 100))}%`;
  // prettier-ignore
  const bar = <span aria-hidden="true" className="block h-full rounded-full bg-accent-fill" style={{ width }} />; // design-token-exempt: width encodes the data proportion rather than a chosen design dimension.
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      className="h-2 w-full overflow-hidden rounded-full bg-surface"
    >
      {bar}
    </div>
  );
}

/** Previous, the month, next. Bounded to the plan's horizon so a reader cannot walk off it. */
export function MonthNav({
  month,
  min,
  max,
  onChange,
}: {
  readonly month: string;
  readonly min: string;
  readonly max: string;
  readonly onChange: (month: string) => void;
}): ReactNode {
  return (
    <div className="flex items-center gap-2">
      <Button
        variant="secondary"
        aria-label="Previous month"
        disabled={month <= min}
        onClick={() => {
          onChange(shiftMonth(month, -1));
        }}
      >
        Previous
      </Button>
      <Text as="span" variant="body" className="min-w-24 text-center font-medium">
        {formatMonth(month, 'long')}
      </Text>
      <Button
        variant="secondary"
        aria-label="Next month"
        disabled={month >= max}
        onClick={() => {
          onChange(shiftMonth(month, 1));
        }}
      >
        Next
      </Button>
    </div>
  );
}

export function SectionHeading({
  id,
  title,
  detail,
  actions,
}: {
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
  readonly actions?: ReactNode;
}): ReactNode {
  return (
    <header className="flex flex-col gap-3 border-b border-divider pb-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <Text as="h3" variant="h3" id={id}>
          {title}
        </Text>
        {detail === undefined ? null : (
          <Text variant="bodySmall" tone="muted">
            {detail}
          </Text>
        )}
      </div>
      {actions === undefined ? null : <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

/** A write's refusal, shown where the person is looking. */
export function WriteError({ message }: { readonly message: string | null }): ReactNode {
  if (message === null) return null;
  return (
    <Text as="p" variant="bodySmall" role="alert">
      {message}
    </Text>
  );
}
