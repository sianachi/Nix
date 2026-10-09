import { Button, Field, Icon, Input, Select, Text, fieldLabel } from '@nix/ui';
import { Trash2 } from 'lucide-react';
import { useId, type ReactNode } from 'react';

import {
  filterGroup,
  isFilterGroup,
  type PropertyDefinition,
  type ViewFilterCondition,
  type ViewFilterRule,
} from '../core/container-model';
import { operatorTakesValue, ruleConditions } from '../core/filter-rules';
import { isComputedType } from '../core/property-types';

/**
 * The smallest honest editor for a view's filters: one row per condition - property, operator,
 * value - with add and remove, and one level of "any of" groups.
 *
 * **The property is free text with the local schema as suggestions, and the hint says why.** A
 * query spans containers, and other containers declare properties this one does not; a `<Select>`
 * over the local schema would make cross-container filtering impossible from the very editor that
 * exists for it. A query also offers the structural fields (`$type`, `$inside`, ...) as
 * suggestions; Core refuses them on any other view.
 *
 * **The operator select offers the closed set this build knows, but the field preserves a token
 * it does not.** A rule written by a newer build round-trips through this editor untouched unless
 * somebody changes it - only the server executes, and the select gains the stray token as an extra
 * option rather than silently rewriting it.
 */

interface OperatorChoice {
  readonly value: string;
  readonly label: string;
}

/**
 * Every operator Core defines (`QueryOperators.All`), with the words a person sees. Since the
 * queries plan (1.2) a query compiles all of them, so both scopes offer the same set.
 */
const OPERATORS: readonly OperatorChoice[] = [
  { value: 'equals', label: 'is' },
  { value: 'not-equals', label: 'is not' },
  { value: 'on', label: 'is on' },
  { value: 'before', label: 'is before' },
  { value: 'on-or-after', label: 'is on or after' },
  { value: 'within-next', label: 'is within the next (days)' },
  { value: 'within-last', label: 'is within the last (days)' },
  { value: 'contains', label: 'contains' },
  { value: 'not-contains', label: 'does not contain' },
  { value: 'greater-than', label: 'is more than' },
  { value: 'less-than', label: 'is less than' },
  { value: 'is-empty', label: 'is empty' },
  { value: 'is-not-empty', label: 'is not empty' },
];

/** The structural fields a query may test, offered as suggestions beside the schema's keys. */
const STRUCTURAL_FIELDS: readonly { readonly key: string; readonly label: string }[] = [
  { key: '$type', label: 'Item type' },
  { key: '$inside', label: 'Inside (an item id)' },
  { key: '$created', label: 'Created on' },
  { key: '$modified', label: 'Last changed on' },
  { key: '$done', label: 'Done' },
];

/** The most conditions one view holds, counting those inside groups (Core's `QueryRules`). */
const MAXIMUM_CONDITIONS = 8;

/** The operators whose value is a number. */
const NUMBER_OPERATORS: ReadonlySet<string> = new Set(['greater-than', 'less-than']);

/** The operators whose value is a day - a token, or a date written yyyy-MM-dd. */
const DAY_OPERATORS: ReadonlySet<string> = new Set(['on', 'before', 'on-or-after']);

/** The operators whose value is a number of days around today. */
const DAY_COUNT_OPERATORS: ReadonlySet<string> = new Set(['within-next', 'within-last']);

const DAY_HINT =
  "'today', 'start-of-week', 'start-of-month', 'same-day-last-week', 'same-day-last-month', or a date written 2026-08-15";

/**
 * The kind of value an operator reads. A value is kept across an operator change only when the
 * kind stays the same: a day under "is more than" or a number under "is on" would be refused on
 * save, so it is cleared rather than carried into a grammar it does not fit.
 */
function valueKindOf(operator: string): 'none' | 'day' | 'days' | 'number' | 'text' {
  if (!operatorTakesValue(operator)) {
    return 'none';
  }
  if (DAY_OPERATORS.has(operator)) {
    return 'day';
  }
  if (DAY_COUNT_OPERATORS.has(operator)) {
    return 'days';
  }
  return NUMBER_OPERATORS.has(operator) ? 'number' : 'text';
}

/** The hint under a value, from the field it tests and the operator that reads it. */
function valueHint(rule: ViewFilterCondition): string | null {
  if (rule.property === '$inside') return 'An item id';
  if (rule.property === '$done') return 'true or false';
  if (DAY_OPERATORS.has(rule.operator)) return DAY_HINT;
  if (DAY_COUNT_OPERATORS.has(rule.operator)) return 'A number of days, 1 to 365';
  if (NUMBER_OPERATORS.has(rule.operator)) return 'A number, written like 12 or -3.5';
  return null;
}

const EMPTY_CONDITION: ViewFilterCondition = { property: '', operator: 'equals', value: '' };

export interface FilterRulesEditorProps {
  readonly rules: readonly ViewFilterRule[];

  /** The local schema's properties, offered as suggestions - never as a bound. */
  readonly schema: readonly PropertyDefinition[];

  readonly onChange: (rules: readonly ViewFilterRule[]) => void;

  /** Query views span readable containers; ordinary views filter only their own children. */
  readonly scope?: 'query' | 'container';

  /** Whether "any of" groups may be added; a template stores plain conditions only. */
  readonly allowGroups?: boolean;
}

export function FilterRulesEditor(props: FilterRulesEditorProps): ReactNode {
  const { rules, schema, onChange, scope = 'query', allowGroups = true } = props;
  const listId = useId();
  const full = ruleConditions(rules).length >= MAXIMUM_CONDITIONS;

  function replace(index: number, next: ViewFilterRule | null): void {
    onChange(
      next === null
        ? rules.filter((_, position) => position !== index)
        : rules.map((rule, position) => (position === index ? next : rule)),
    );
  }

  return (
    <div className="@container flex min-w-0 flex-col gap-2">
      <Text variant="note" tone="muted" as="p">
        {scope === 'query'
          ? 'Filters run across every container you can read, joined with AND; an "any of" group matches when one of its filters does. A property here is a key that may live in other containers, so it is typed rather than picked.'
          : 'Filters are joined with AND, and an "any of" group matches when one of its filters does. They hide children from this view only. Other views keep their own filters.'}
      </Text>

      <datalist id={listId}>
        {/* Computed properties are not suggested: a filter is compiled and run by the server
            against stored values, and a formula has none - it is evaluated where it is drawn.
            A rule over one would match nothing, forever, with nothing on screen to say why.
            Suggestions are still only suggestions; the box stays free text, so nothing here
            stops somebody typing a key that lives in another container. */}
        {schema
          .filter((property) => !isComputedType(property.type))
          .map((property) => (
            <option key={property.key} value={property.key}>
              {property.label}
            </option>
          ))}
        {scope === 'query'
          ? STRUCTURAL_FIELDS.map((field) => (
              <option key={field.key} value={field.key}>
                {field.label}
              </option>
            ))
          : null}
      </datalist>

      {rules.map((rule, index) =>
        // The index is the identity here: rules have no ids, and reordering is not offered, so
        // position is stable for the life of the row.
        isFilterGroup(rule) ? (
          <fieldset
            key={index}
            className="flex min-w-0 flex-col gap-2 rounded-md border border-divider p-3"
          >
            <legend className={fieldLabel}>Any of</legend>
            {rule.any.map((condition, inner) => (
              <ConditionRow
                key={inner}
                rule={condition}
                listId={listId}
                onChange={(next) => {
                  replace(index, {
                    ...rule,
                    any: rule.any.map((existing, position) =>
                      position === inner ? next : existing,
                    ),
                  });
                }}
                onRemove={() => {
                  const remaining = rule.any.filter((_, position) => position !== inner);
                  // An empty group is refused on save, so removing its last filter removes it.
                  replace(index, remaining.length === 0 ? null : { ...rule, any: remaining });
                }}
              />
            ))}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                disabled={full}
                onClick={() => {
                  replace(index, { ...rule, any: [...rule.any, EMPTY_CONDITION] });
                }}
              >
                Add a filter to this group
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  replace(index, null);
                }}
              >
                Remove this group
              </Button>
            </div>
          </fieldset>
        ) : (
          <ConditionRow
            key={index}
            rule={rule}
            listId={listId}
            onChange={(next) => {
              replace(index, next);
            }}
            onRemove={() => {
              replace(index, null);
            }}
          />
        ),
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          disabled={full}
          onClick={() => {
            onChange([...rules, EMPTY_CONDITION]);
          }}
        >
          Add a filter
        </Button>
        {allowGroups ? (
          <Button
            variant="secondary"
            disabled={full}
            onClick={() => {
              onChange([...rules, filterGroup([EMPTY_CONDITION])]);
            }}
          >
            Add an any-of group
          </Button>
        ) : null}
        {full ? (
          <Text variant="note" tone="muted" as="p">
            A view holds at most {MAXIMUM_CONDITIONS} filters, counting those in groups.
          </Text>
        ) : null}
      </div>
    </div>
  );
}

interface ConditionRowProps {
  readonly rule: ViewFilterCondition;
  readonly listId: string;
  readonly onChange: (rule: ViewFilterCondition) => void;
  readonly onRemove: () => void;
}

function ConditionRow({ rule, listId, onChange, onRemove }: ConditionRowProps): ReactNode {
  const known = OPERATORS.some((operator) => operator.value === rule.operator);
  const hint = valueHint(rule);

  return (
    <div className="grid min-w-0 grid-cols-1 gap-2 @xl:grid-cols-2 @4xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] @xl:items-end">
      <Field label="Property" className="min-w-0">
        {(control) => (
          <Input
            {...control}
            list={listId}
            value={rule.property}
            onChange={(event) => {
              onChange({ ...rule, property: event.target.value });
            }}
          />
        )}
      </Field>

      <Field label="Condition" className="min-w-0">
        {(control) => (
          <Select
            {...control}
            value={rule.operator}
            onChange={(event) => {
              const operator = event.target.value;
              // A value left from an operator that reads another kind of value - or one under an
              // operator that takes none - is dropped rather than saved and refused.
              onChange(
                valueKindOf(operator) === valueKindOf(rule.operator)
                  ? { ...rule, operator }
                  : { ...rule, operator, value: '' },
              );
            }}
          >
            {OPERATORS.map((operator) => (
              <option key={operator.value} value={operator.value}>
                {operator.label}
              </option>
            ))}
            {/* A token from a newer build: preserved and named, never rewritten. */}
            {known ? null : <option value={rule.operator}>{rule.operator}</option>}
          </Select>
        )}
      </Field>

      {operatorTakesValue(rule.operator) ? (
        <Field label="Value" className="min-w-0" {...(hint === null ? {} : { hint })}>
          {(control) => (
            <Input
              {...control}
              value={rule.value}
              onChange={(event) => {
                onChange({ ...rule, value: event.target.value });
              }}
            />
          )}
        </Field>
      ) : (
        // Keeps the row's grid columns aligned when the value has nothing to ask.
        <div aria-hidden="true" />
      )}

      <Button
        variant="icon"
        className="justify-self-start"
        aria-label={`Remove the filter on ${rule.property.length > 0 ? rule.property : 'this property'}`}
        onClick={onRemove}
      >
        <Icon icon={Trash2} size="sm" />
      </Button>
    </div>
  );
}
