import { addDays, dayFromText, dayText } from './calendar-dates';
import type { PropertyOwner, ViewFilterRule } from './container-model';

/**
 * A view's stored filter rules, evaluated against the children already loaded.
 *
 * The grammar is the server's (`QueryOperators` in FilterRule.cs) and so are the meanings, operator
 * for operator: a query view compiles these rules to SQL, and a board filtered by the same rule has
 * to show the same items or the two views of one thing disagree. Where this goes further than the
 * SQL - an `equals` against a multi-select matches an item carrying that option among others - the
 * SQL is the one that is narrower, and the server half is the place to widen it.
 *
 * **Rules AND together**, as they do on the server (ADR-0039).
 */

/** What a rule needs besides the item: the reader's day and who "me" is. */
export interface RuleContext {
  /** The reader's own calendar day, `yyyy-MM-dd`, which `today` resolves to. */
  readonly today: string;

  /**
   * The signed-in principal's id, which `me` resolves to, or null while it is unknown.
   *
   * Unknown resolves `me` to nothing at all - not to "anybody" - so a rule reading "assigned to me"
   * shows no items until the answer arrives rather than flashing everyone's.
   */
  readonly principalId: string | null;
}

/** The value tokens, spelled once. */
export const TODAY_TOKEN = 'today';
export const ME_TOKEN = 'me';

/** Every operator this build evaluates. The server's set, plus the ones this phase adds. */
export const RULE_OPERATORS = [
  'equals',
  'not-equals',
  'contains',
  'not-contains',
  'greater-than',
  'less-than',
  'on',
  'before',
  'on-or-after',
  'within-next',
  'is-empty',
  'is-not-empty',
] as const;

export type RuleOperator = (typeof RULE_OPERATORS)[number];

/** Whether an operator takes no value - its meaning is entirely about the property's presence. */
export function operatorTakesValue(operator: string): boolean {
  return operator !== 'is-empty' && operator !== 'is-not-empty';
}

/** Keeps the items every rule admits. Returns the array it was given when there are no rules. */
export function applyRules<TItem extends PropertyOwner>(
  items: readonly TItem[],
  rules: readonly ViewFilterRule[],
  context: RuleContext,
): readonly TItem[] {
  if (rules.length === 0) {
    return items;
  }

  return items.filter((item) => rules.every((rule) => evaluateRule(item, rule, context)));
}

/**
 * Whether one item satisfies one rule.
 *
 * An operator this build does not know admits everything. A newer build wrote it, the server will
 * have refused it if it were wrong, and hiding items over a word this build cannot read would be a
 * filter nobody can see the reason for.
 */
export function evaluateRule(
  item: PropertyOwner,
  rule: ViewFilterRule,
  context: RuleContext,
): boolean {
  const value = item.properties[rule.property];

  switch (rule.operator) {
    case 'equals':
      return equals(value, resolveMe(rule.value, context));
    case 'not-equals':
      // Absence counts as "not equal", the server's own rule: Overdue asks for done not-equals
      // true, and an item that never had the property is exactly as not-done as one set false.
      return !equals(value, resolveMe(rule.value, context));
    case 'contains':
      return contains(value, rule.value);
    case 'not-contains':
      return !contains(value, rule.value);
    case 'greater-than':
      return compareNumber(value, rule.value, (a, b) => a > b);
    case 'less-than':
      return compareNumber(value, rule.value, (a, b) => a < b);
    case 'on':
      return compareDay(value, rule.value, context, (a, b) => a === b);
    case 'before':
      return compareDay(value, rule.value, context, (a, b) => a < b);
    case 'on-or-after':
      return compareDay(value, rule.value, context, (a, b) => a >= b);
    case 'within-next':
      return withinNext(value, rule.value, context);
    case 'is-empty':
      return isEmpty(value);
    case 'is-not-empty':
      return !isEmpty(value);
    default:
      return true;
  }
}

function resolveMe(value: string, context: RuleContext): string | null {
  return value === ME_TOKEN ? context.principalId : value;
}

/**
 * Equality as the server's `properties ->> key = value` reads it: the stored value's text against
 * the literal, so a checkbox matches `true` and a number matches its digits.
 */
function equals(value: unknown, expected: string | null): boolean {
  if (expected === null) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some((entry) => entry === expected);
  }

  if (typeof value === 'string') {
    return value === expected;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value) === expected;
  }

  return false;
}

/** Case-insensitive substring for text; membership for a multi-select. */
function contains(value: unknown, needle: string): boolean {
  const lowered = needle.toLocaleLowerCase();

  if (Array.isArray(value)) {
    return value.some(
      (entry) => typeof entry === 'string' && entry.toLocaleLowerCase().includes(lowered),
    );
  }

  if (typeof value === 'string' || typeof value === 'number') {
    return String(value).toLocaleLowerCase().includes(lowered);
  }

  return false;
}

function compareNumber(
  value: unknown,
  literal: string,
  test: (actual: number, expected: number) => boolean,
): boolean {
  const expected = Number(literal);
  if (literal.trim().length === 0 || !Number.isFinite(expected)) {
    return false;
  }

  const actual =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(actual) && test(actual, expected);
}

/**
 * The day a stored date-shaped value falls on: its first ten characters, which is `left(value, 10)`
 * on the server. A timestamp's first ten are its local day in the zone it was written in, so the
 * two agree on which day a 23:30 meeting belongs to.
 */
function dayOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 10) {
    return null;
  }

  const day = value.slice(0, 10);
  return dayFromText(day) === null ? null : day;
}

function resolveDay(literal: string, context: RuleContext): string | null {
  const day = literal === TODAY_TOKEN ? context.today : literal;
  return dayFromText(day) === null ? null : day;
}

function compareDay(
  value: unknown,
  literal: string,
  context: RuleContext,
  test: (actual: string, expected: string) => boolean,
): boolean {
  const actual = dayOf(value);
  const expected = resolveDay(literal, context);

  // `yyyy-MM-dd` orders correctly as plain text, which is why the server can compare it as text and
  // why this can too.
  return actual !== null && expected !== null && test(actual, expected);
}

function withinNext(value: unknown, literal: string, context: RuleContext): boolean {
  const actual = dayOf(value);
  const days = Number(literal);
  const from = dayFromText(context.today);

  if (actual === null || from === null || !Number.isInteger(days) || days < 1) {
    return false;
  }

  // BETWEEN today AND today + n, inclusive at both ends, as the server compiles it.
  return actual >= context.today && actual <= dayText(addDays(from, days));
}

function isEmpty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}
