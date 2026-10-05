import type {
  AutomationRuleInput,
  AutomationRuleResponse as AutomationRule,
} from '@nix/api-client';

import {
  automationActionSchema,
  automationConditionSchema,
  automationTriggerSchema,
  type AutomationAction,
  type AutomationCondition,
  type AutomationConditionOperator,
  type AutomationItemReference,
  type AutomationTrigger,
  type AutomationWeekday,
} from './automation-grammar';

/**
 * The automation editor's working copy, and the translation to and from the rule document Core
 * stores (ADR-0051 section 6, Amendment 4).
 *
 * **Text in, JSON out.** A form holds what somebody typed - "2", "days", "before" - and the rule
 * holds what Core reads - `offsetMinutes: -2880`. Keeping the two apart means a half-typed number
 * is a draft with an error beside it, not a rule document that cannot be built.
 *
 * **Errors are keyed by Core's own paths** (`trigger.time`, `actions[1].key`), so a refusal that
 * came back from the server lands on the same field a local check would have used.
 */

export type TriggerKind = AutomationTrigger['type'];

export type ScheduleFrequency = 'daily' | 'weekly' | 'monthly';

/** How a typed value is turned into JSON: the property's shape, as far as the editor knows it. */
export type ValueType = 'text' | 'number' | 'boolean' | 'list';

export interface ValueDraft {
  readonly type: ValueType;
  readonly text: string;
}

export interface ScheduleDraft {
  readonly freq: ScheduleFrequency;
  readonly interval: string;
  readonly weekdays: readonly AutomationWeekday[];
  readonly time: string;
  /** An IANA zone, or empty to follow the owner's notification settings. */
  readonly timeZone: string;
  /** Kept from the stored rule so saving never moves the anchor its intervals count from. */
  readonly startDate: string | null;
}

export type OffsetUnit = 'minutes' | 'hours' | 'days';

export interface DateDraft {
  readonly key: string;
  readonly amount: string;
  readonly unit: OffsetUnit;
  readonly direction: 'before' | 'after';
  readonly time: string;
}

/** Any value, a particular one, or "no value" (the property was cleared). */
export interface MatchDraft {
  readonly mode: 'any' | 'value' | 'empty';
  readonly value: ValueDraft;
}

export interface PropertyDraft {
  readonly key: string;
  readonly from: MatchDraft;
  readonly to: MatchDraft;
}

export interface ConditionDraft {
  readonly key: string;
  readonly op: AutomationConditionOperator;
  readonly value: ValueDraft;
}

export type ItemReferenceKind = 'triggering_item' | 'scope' | 'item';

export interface SetPropertyDraft {
  readonly kind: 'set_property';
  readonly target: 'triggering_item' | 'item';
  readonly targetItemId: string | null;
  readonly key: string;
  /** Clears the property instead of setting a value. */
  readonly clear: boolean;
  readonly value: ValueDraft;
}

export interface CreateItemDraft {
  readonly kind: 'create_item';
  readonly parent: ItemReferenceKind;
  readonly parentItemId: string | null;
  readonly itemType: string;
  readonly title: string;
  /** Carried through untouched: the editor does not offer them, but a stored rule may have some. */
  readonly properties: Readonly<Record<string, unknown>> | null;
}

export interface NotifyDraft {
  readonly kind: 'notify';
  readonly title: string;
  readonly body: string;
}

export type ActionDraft = SetPropertyDraft | CreateItemDraft | NotifyDraft;

export interface AutomationDraft {
  readonly name: string;
  readonly enabled: boolean;
  readonly scopeItemId: string | null;
  readonly triggerKind: TriggerKind;
  readonly schedule: ScheduleDraft;
  readonly date: DateDraft;
  readonly property: PropertyDraft;
  readonly conditions: readonly ConditionDraft[];
  readonly actions: readonly ActionDraft[];
}

export const MAX_CONDITIONS = 5;
export const MAX_ACTIONS = 5;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_OFFSET_MINUTES = 10_080;
const UNIT_MINUTES: Record<OffsetUnit, number> = { minutes: 1, hours: 60, days: 1440 };

export const WEEKDAYS: readonly { readonly value: AutomationWeekday; readonly label: string }[] = [
  { value: 'mo', label: 'Monday' },
  { value: 'tu', label: 'Tuesday' },
  { value: 'we', label: 'Wednesday' },
  { value: 'th', label: 'Thursday' },
  { value: 'fr', label: 'Friday' },
  { value: 'sa', label: 'Saturday' },
  { value: 'su', label: 'Sunday' },
];

const EMPTY_VALUE: ValueDraft = { type: 'text', text: '' };

export function emptyValue(type: ValueType = 'text'): ValueDraft {
  return { type, text: type === 'boolean' ? 'true' : '' };
}

export function emptyAction(kind: ActionDraft['kind'], hasScope: boolean): ActionDraft {
  switch (kind) {
    case 'set_property':
      return {
        kind,
        target: 'triggering_item',
        targetItemId: null,
        key: '',
        clear: false,
        value: EMPTY_VALUE,
      };
    case 'create_item':
      return {
        kind,
        parent: hasScope ? 'scope' : 'item',
        parentItemId: null,
        itemType: 'note',
        title: '',
        properties: null,
      };
    case 'notify':
      return { kind, title: '', body: '' };
  }
}

export function emptyCondition(): ConditionDraft {
  return { key: '', op: 'equals', value: EMPTY_VALUE };
}

/** A new rule: a notification on a property change inside the scope, or a daily schedule without one. */
export function emptyDraft(scopeItemId: string | null): AutomationDraft {
  return {
    name: '',
    enabled: true,
    scopeItemId,
    triggerKind: scopeItemId === null ? 'schedule' : 'property_changed',
    schedule: {
      freq: 'daily',
      interval: '1',
      weekdays: [],
      time: '09:00',
      timeZone: '',
      startDate: null,
    },
    date: { key: 'due_date', amount: '0', unit: 'days', direction: 'before', time: '09:00' },
    property: {
      key: '',
      from: { mode: 'any', value: EMPTY_VALUE },
      to: { mode: 'any', value: EMPTY_VALUE },
    },
    conditions: [],
    actions: [emptyAction('notify', scopeItemId !== null)],
  };
}

/** Which value shape a property type stores, for turning typed text into JSON. */
export function valueTypeFor(propertyType: string | undefined): ValueType {
  switch (propertyType) {
    case 'number':
    case 'priority':
    case 'estimate':
      return 'number';
    case 'checkbox':
    case 'completion':
      return 'boolean';
    case 'multi_select':
      return 'list';
    default:
      return 'text';
  }
}

// ---------------------------------------------------------------------------------------------
// Draft -> rule document
// ---------------------------------------------------------------------------------------------

function valueFromDraft(value: ValueDraft): unknown {
  switch (value.type) {
    case 'number':
      return Number(value.text);
    case 'boolean':
      return value.text === 'true';
    case 'list':
      return value.text
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    case 'text':
      return value.text;
  }
}

function offsetMinutes(date: DateDraft): number {
  const minutes = Number(date.amount) * UNIT_MINUTES[date.unit];
  return date.direction === 'before' && minutes !== 0 ? -minutes : minutes;
}

function triggerFromDraft(draft: AutomationDraft): AutomationTrigger {
  switch (draft.triggerKind) {
    case 'schedule': {
      const { schedule } = draft;
      return {
        type: 'schedule',
        freq: schedule.freq,
        interval: Number(schedule.interval),
        ...(schedule.freq === 'weekly' && schedule.weekdays.length > 0
          ? {
              weekdays: WEEKDAYS.map((day) => day.value).filter((day) =>
                schedule.weekdays.includes(day),
              ),
            }
          : {}),
        time: schedule.time,
        ...(schedule.timeZone.trim() === '' ? {} : { timeZone: schedule.timeZone.trim() }),
        ...(schedule.startDate === null ? {} : { startDate: schedule.startDate }),
      };
    }
    case 'date_arrives':
      return {
        type: 'date_arrives',
        key: draft.date.key.trim(),
        offsetMinutes: offsetMinutes(draft.date),
        time: draft.date.time,
      };
    case 'property_changed': {
      const match = (entry: MatchDraft): { value: unknown } | undefined =>
        entry.mode === 'any'
          ? undefined
          : { value: entry.mode === 'empty' ? null : valueFromDraft(entry.value) };
      const from = match(draft.property.from);
      const to = match(draft.property.to);
      return {
        type: 'property_changed',
        key: draft.property.key.trim(),
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
      };
    }
  }
}

function conditionFromDraft(condition: ConditionDraft): AutomationCondition {
  const comparesValue = condition.op === 'equals' || condition.op === 'not_equals';
  return {
    key: condition.key.trim(),
    op: condition.op,
    ...(comparesValue ? { value: valueFromDraft(condition.value) } : {}),
  };
}

function reference(kind: ItemReferenceKind, itemId: string | null): AutomationItemReference {
  return kind === 'item' ? { itemId: itemId ?? '' } : kind;
}

function actionFromDraft(action: ActionDraft): AutomationAction {
  switch (action.kind) {
    case 'set_property':
      return {
        type: 'set_property',
        target: reference(action.target, action.targetItemId),
        key: action.key.trim(),
        value: action.clear ? null : valueFromDraft(action.value),
      };
    case 'create_item':
      return {
        type: 'create_item',
        parent: reference(action.parent, action.parentItemId),
        itemType: action.itemType.trim(),
        title: action.title,
        ...(action.properties === null ? {} : { properties: { ...action.properties } }),
      };
    case 'notify':
      return { type: 'notify', title: action.title, body: action.body };
  }
}

/** The rule document to send. Call {@link validateDraft} first; this does not check. */
export function ruleInputFromDraft(draft: AutomationDraft): AutomationRuleInput {
  return {
    name: draft.name.trim(),
    enabled: draft.enabled,
    scopeItemId: draft.scopeItemId,
    trigger: triggerFromDraft(draft),
    conditions: draft.triggerKind === 'schedule' ? [] : draft.conditions.map(conditionFromDraft),
    actions: draft.actions.map(actionFromDraft),
  };
}

// ---------------------------------------------------------------------------------------------
// Rule document -> draft
// ---------------------------------------------------------------------------------------------

function valueToDraft(value: unknown): ValueDraft {
  if (typeof value === 'number') return { type: 'number', text: String(value) };
  if (typeof value === 'boolean') return { type: 'boolean', text: String(value) };
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return { type: 'list', text: value.join(', ') };
  }
  if (typeof value === 'string') return { type: 'text', text: value };
  return EMPTY_VALUE;
}

/** Whether a stored value survives a trip through the editor's text fields unchanged. */
function isEditableValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
  );
}

function offsetToDraft(minutes: number): Pick<DateDraft, 'amount' | 'unit' | 'direction'> {
  const direction = minutes < 0 ? 'before' : 'after';
  const size = Math.abs(minutes);
  const unit: OffsetUnit =
    size !== 0 && size % 1440 === 0 ? 'days' : size !== 0 && size % 60 === 0 ? 'hours' : 'minutes';
  return { amount: String(size / UNIT_MINUTES[unit]), unit, direction };
}

function matchToDraft(match: { value?: unknown } | undefined): MatchDraft {
  if (match === undefined) return { mode: 'any', value: EMPTY_VALUE };
  if (match.value === null || match.value === undefined)
    return { mode: 'empty', value: EMPTY_VALUE };
  return { mode: 'value', value: valueToDraft(match.value) };
}

function referenceKind(reference: AutomationItemReference): {
  readonly kind: ItemReferenceKind;
  readonly itemId: string | null;
} {
  return typeof reference === 'string'
    ? { kind: reference, itemId: null }
    : { kind: 'item', itemId: reference.itemId };
}

function actionToDraft(action: AutomationAction): ActionDraft | null {
  switch (action.type) {
    case 'set_property': {
      const target = referenceKind(action.target);
      if (target.kind === 'scope' || !isEditableValue(action.value)) return null;
      return {
        kind: 'set_property',
        target: target.kind,
        targetItemId: target.itemId,
        key: action.key,
        clear: action.value === null,
        value: action.value === null ? EMPTY_VALUE : valueToDraft(action.value),
      };
    }
    case 'create_item': {
      const parent = referenceKind(action.parent);
      return {
        kind: 'create_item',
        parent: parent.kind,
        parentItemId: parent.itemId,
        itemType: action.itemType,
        title: action.title,
        properties: action.properties ?? null,
      };
    }
    case 'notify':
      return { kind: 'notify', title: action.title, body: action.body ?? '' };
  }
}

/**
 * The editor's copy of a stored rule, or null when the rule carries something this build cannot
 * show faithfully - a trigger or action a newer build wrote, or a value no text field can hold.
 * Null is the honest answer there: an editor that dropped what it did not understand would save a
 * different rule than the one on screen.
 */
export function draftFromRule(rule: AutomationRule): AutomationDraft | null {
  const trigger = automationTriggerSchema.safeParse(rule.trigger);
  if (!trigger.success) return null;

  const conditions: ConditionDraft[] = [];
  for (const raw of rule.conditions) {
    const parsed = automationConditionSchema.safeParse(raw);
    if (!parsed.success || !isEditableValue(parsed.data.value)) return null;
    conditions.push({
      key: parsed.data.key,
      op: parsed.data.op,
      value: valueToDraft(parsed.data.value),
    });
  }

  const actions: ActionDraft[] = [];
  for (const raw of rule.actions) {
    const parsed = automationActionSchema.safeParse(raw);
    if (!parsed.success) return null;
    const action = actionToDraft(parsed.data);
    if (action === null) return null;
    actions.push(action);
  }

  const base = emptyDraft(rule.scopeItemId);
  const value = trigger.data;
  const draft: AutomationDraft = {
    ...base,
    name: rule.name,
    enabled: rule.enabled,
    triggerKind: value.type,
    conditions,
    actions,
  };

  switch (value.type) {
    case 'schedule':
      return {
        ...draft,
        schedule: {
          freq: value.freq,
          interval: String(value.interval),
          weekdays: value.weekdays ?? [],
          time: value.time,
          timeZone: value.timeZone ?? '',
          startDate: value.startDate ?? null,
        },
      };
    case 'date_arrives':
      return {
        ...draft,
        date: {
          key: value.key,
          time: value.time ?? '09:00',
          ...offsetToDraft(value.offsetMinutes ?? 0),
        },
      };
    case 'property_changed': {
      if (!isEditableValue(value.from?.value) || !isEditableValue(value.to?.value)) return null;
      return {
        ...draft,
        property: { key: value.key, from: matchToDraft(value.from), to: matchToDraft(value.to) },
      };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

/** Field path (Core's spelling) to the reason, in plain sentence case. */
export type DraftErrors = Readonly<Record<string, string>>;

function checkKey(key: string, path: string, errors: Record<string, string>): void {
  const trimmed = key.trim();
  if (trimmed.length === 0) errors[path] = 'Choose a property.';
  else if (trimmed.length > 128) errors[path] = 'Use a property key of 128 characters or fewer.';
  else if (trimmed.startsWith('$')) errors[path] = 'System properties cannot be used.';
}

function checkValue(value: ValueDraft, path: string, errors: Record<string, string>): void {
  if (
    value.type === 'number' &&
    (value.text.trim() === '' || !Number.isFinite(Number(value.text)))
  ) {
    errors[path] = 'Enter a number.';
  }
}

function checkTime(time: string, path: string, errors: Record<string, string>): void {
  if (!TIME.test(time)) errors[path] = 'Enter a time.';
}

export function validateDraft(draft: AutomationDraft): DraftErrors {
  const errors: Record<string, string> = {};
  const isSchedule = draft.triggerKind === 'schedule';

  const name = draft.name.trim();
  if (name.length === 0) errors.name = 'Give the automation a name.';
  else if (name.length > 200) errors.name = 'Use a name of 200 characters or fewer.';

  switch (draft.triggerKind) {
    case 'schedule': {
      const interval = Number(draft.schedule.interval);
      if (!Number.isInteger(interval) || interval < 1 || interval > 366) {
        errors['trigger.interval'] = 'Enter a whole number from 1 to 366.';
      }
      if (draft.schedule.freq === 'weekly' && draft.schedule.weekdays.length === 0) {
        errors['trigger.weekdays'] = 'Choose at least one day.';
      }
      checkTime(draft.schedule.time, 'trigger.time', errors);
      break;
    }
    case 'date_arrives': {
      checkKey(draft.date.key, 'trigger.key', errors);
      const amount = Number(draft.date.amount);
      if (!Number.isInteger(amount) || amount < 0) {
        errors['trigger.offsetMinutes'] = 'Enter a whole number.';
      } else if (Math.abs(offsetMinutes(draft.date)) > MAX_OFFSET_MINUTES) {
        errors['trigger.offsetMinutes'] = 'Keep the offset within a week.';
      }
      checkTime(draft.date.time, 'trigger.time', errors);
      break;
    }
    case 'property_changed': {
      checkKey(draft.property.key, 'trigger.key', errors);
      if (draft.property.from.mode === 'value')
        checkValue(draft.property.from.value, 'trigger.from', errors);
      if (draft.property.to.mode === 'value')
        checkValue(draft.property.to.value, 'trigger.to', errors);
      break;
    }
  }

  if (isSchedule && draft.conditions.length > 0) {
    errors.conditions = 'A schedule has no triggering item, so it cannot have conditions.';
  } else if (draft.conditions.length > MAX_CONDITIONS) {
    errors.conditions = 'Use at most five conditions.';
  }
  if (!isSchedule) {
    draft.conditions.forEach((condition, index) => {
      checkKey(condition.key, `conditions[${String(index)}].key`, errors);
      if (condition.op === 'equals' || condition.op === 'not_equals') {
        checkValue(condition.value, `conditions[${String(index)}].value`, errors);
      }
    });
  }

  if (draft.actions.length === 0) errors.actions = 'Add at least one action.';
  else if (draft.actions.length > MAX_ACTIONS) errors.actions = 'Use at most five actions.';

  draft.actions.forEach((action, index) => {
    const path = `actions[${String(index)}]`;
    switch (action.kind) {
      case 'set_property':
        if (action.target === 'triggering_item' && isSchedule) {
          errors[`${path}.target`] = 'A schedule has no triggering item. Choose an item instead.';
        }
        if (action.target === 'item' && action.targetItemId === null) {
          errors[`${path}.target`] = 'Choose the item to update.';
        }
        checkKey(action.key, `${path}.key`, errors);
        if (!action.clear) checkValue(action.value, `${path}.value`, errors);
        break;
      case 'create_item': {
        if (action.parent === 'triggering_item' && isSchedule) {
          errors[`${path}.parent`] = 'A schedule has no triggering item. Choose a parent instead.';
        }
        if (action.parent === 'scope' && draft.scopeItemId === null) {
          errors[`${path}.parent`] = 'Choose a scope first, or pick a parent item.';
        }
        if (action.parent === 'item' && action.parentItemId === null) {
          errors[`${path}.parent`] = 'Choose the parent item.';
        }
        const title = action.title.trim();
        if (title.length === 0) errors[`${path}.title`] = 'Give the new item a title.';
        else if (action.title.length > 500)
          errors[`${path}.title`] = 'Use 500 characters or fewer.';
        const itemType = action.itemType.trim();
        if (itemType.length === 0 || itemType.length > 64) {
          errors[`${path}.itemType`] = 'Choose what kind of item to create.';
        }
        break;
      }
      case 'notify':
        if (action.title.trim().length === 0)
          errors[`${path}.title`] = 'Give the notification a title.';
        else if (action.title.length > 200)
          errors[`${path}.title`] = 'Use 200 characters or fewer.';
        if (action.body.length > 1000) errors[`${path}.body`] = 'Use 1,000 characters or fewer.';
        break;
    }
  });

  return errors;
}

// ---------------------------------------------------------------------------------------------
// Refusals and words
// ---------------------------------------------------------------------------------------------

export interface Violation {
  /** Core's path for the field, or null for a reason about the rule as a whole. */
  readonly path: string | null;
  readonly reason: string;
}

const VIOLATION = /^([A-Za-z]+(?:\[\d+\])?(?:\.[A-Za-z$_][\w$]*(?:\[\d+\])?)*): (.+)$/;

/**
 * Splits an `automation.invalid` problem's detail - Core joins every violation as `path: reason`
 * with `; ` - back into the fields they belong to. A detail that is not in that form is kept whole.
 */
export function parseViolations(detail: string): readonly Violation[] {
  const parts = detail.split('; ').map((part) => part.trim());
  const parsed = parts.map((part) => {
    const match = VIOLATION.exec(part);
    return match === null ? null : { path: match[1] ?? null, reason: match[2] ?? part };
  });
  if (parsed.some((entry) => entry === null)) return [{ path: null, reason: detail }];
  return parsed.filter((entry): entry is Violation => entry !== null);
}

const STATUS_WORDS: Readonly<Record<string, string>> = {
  succeeded: 'Ran',
  noop: 'Nothing to change',
  skipped: 'Skipped',
  failed: 'Failed',
  throttled: 'Throttled',
  suppressed: 'Stopped',
};

export function describeRunStatus(status: string): string {
  return (
    STATUS_WORDS[status] ??
    `${status.charAt(0).toUpperCase()}${status.slice(1).replaceAll('_', ' ')}`
  );
}

const REASON_WORDS: Readonly<Record<string, string>> = {
  rule_gone: 'The automation was deleted.',
  rule_disabled: 'The automation was turned off.',
  owner_inactive: 'Your account is not active.',
  access_lost: 'You no longer have access to this workspace.',
  item_gone: 'The item is gone or in the trash.',
  scope_gone: 'The scope item is gone or in the trash.',
  out_of_scope: 'The item is no longer inside the scope.',
  item_required: 'This automation needs an item to run against.',
  item_locked: 'The item is locked.',
  scope_locked: 'The scope item is locked.',
  schedule_changed: 'The schedule changed before it ran.',
  date_changed: 'The date changed before it ran.',
  condition_changed: 'The property no longer matches the trigger.',
  trigger_changed: 'The property no longer matches the trigger.',
  no_change: 'The value did not really change.',
  conditions_unmet: 'The conditions were not met.',
  throttled: 'Skipped to stay within the run limits.',
  duplicate: 'It already ran for this event.',
  chain_depth: 'Stopped so one automation cannot set off a chain of others.',
  action_failed: 'An action failed.',
  'action.unavailable': 'This action is not available yet.',
  'set_property.target_not_found': 'The item to update could not be found.',
  'create_item.parent_not_found': 'The parent for the new item could not be found.',
  'notify.not_owner': 'The notification could not be sent to you.',
};

/** A run's reason code in words, or the code itself for one this build has never seen. */
export function describeRunReason(reason: string): string {
  const known = REASON_WORDS[reason];
  if (known !== undefined) return known;
  if (reason.endsWith('_locked') || reason.endsWith('.locked'))
    return 'Something it needs is locked.';
  return `Stopped with reason code ${reason}.`;
}

export function describeRunOrigin(origin: string): string {
  switch (origin) {
    case 'schedule':
      return 'On schedule';
    case 'date':
      return 'Date arrived';
    case 'property':
      return 'Property changed';
    case 'manual':
      return 'Run now';
    default:
      return origin;
  }
}

/** Why Core turned a rule off, in words. */
export function describeDisabledReason(reason: string): string {
  return reason === 'repeated_failures'
    ? 'Turned off after five failed runs in a row. Check the run log, fix what it reports, then turn it back on.'
    : `Turned off by Nix (reason code ${reason}). Check the run log before turning it back on.`;
}

function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1) ?? ''}`;
}

function describeValue(value: unknown): string {
  if (value === null || value === undefined) return 'nothing';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function plural(count: number, unit: string): string {
  return `${String(count)} ${unit}${count === 1 ? '' : 's'}`;
}

/** One line saying when a rule fires, for its row in the list. */
export function summarizeTrigger(raw: unknown): string {
  const parsed = automationTriggerSchema.safeParse(raw);
  if (!parsed.success) return 'A trigger this version of Nix cannot show';
  const trigger = parsed.data;
  switch (trigger.type) {
    case 'schedule': {
      const unit = { daily: 'day', weekly: 'week', monthly: 'month' }[trigger.freq];
      const every =
        trigger.interval === 1 ? `Every ${unit}` : `Every ${plural(trigger.interval, unit)}`;
      const days =
        trigger.freq === 'weekly' && trigger.weekdays !== undefined && trigger.weekdays.length > 0
          ? ` on ${joinWords(WEEKDAYS.filter((day) => trigger.weekdays?.includes(day.value)).map((day) => day.label))}`
          : '';
      return `${every}${days} at ${trigger.time}`;
    }
    case 'date_arrives': {
      const minutes = trigger.offsetMinutes ?? 0;
      if (minutes === 0) return `When ${trigger.key} arrives`;
      const { amount, unit, direction } = offsetToDraft(minutes);
      const singular = { minutes: 'minute', hours: 'hour', days: 'day' }[unit];
      return `${plural(Number(amount), singular)} ${direction} ${trigger.key} arrives`;
    }
    case 'property_changed': {
      const from = trigger.from === undefined ? '' : ` from ${describeValue(trigger.from.value)}`;
      const to = trigger.to === undefined ? '' : ` to ${describeValue(trigger.to.value)}`;
      return `When ${trigger.key} changes${from}${to}`;
    }
  }
}
