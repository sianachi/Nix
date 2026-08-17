import { Button, Field, Icon, Input, Text, cn } from '@nix/ui';
import { Trash2 } from 'lucide-react';
import { useId, type ReactNode } from 'react';

import type { PropertyDefinition, ViewFilterRule } from '../core/container-model';

/**
 * The smallest honest editor for a query view's filters: one row per rule - property, operator,
 * value - with add and remove.
 *
 * **The property is free text with the local schema as suggestions, and the hint says why.** A
 * query spans containers, and other containers declare properties this one does not; a `<Select>`
 * over the local schema would make cross-container filtering impossible from the very editor that
 * exists for it.
 *
 * **The operator select offers the closed set this build knows, but the field preserves a token
 * it does not.** A rule written by a newer build round-trips through this editor untouched unless
 * somebody changes it - only the server executes, and the select gains the stray token as a
 * disabled-looking extra option rather than silently rewriting it.
 */

/** The operators this build offers, with the words a person sees. */
const OPERATORS: readonly { readonly value: string; readonly label: string }[] = [
  { value: 'equals', label: 'is' },
  { value: 'not-equals', label: 'is not' },
  { value: 'on', label: 'is on' },
  { value: 'before', label: 'is before' },
  { value: 'on-or-after', label: 'is on or after' },
  { value: 'within-next', label: 'is within the next (days)' },
];

/** The operators whose value is a day - `today`, or a date written yyyy-MM-dd. */
const DAY_OPERATORS: ReadonlySet<string> = new Set(['on', 'before', 'on-or-after']);

export interface FilterRulesEditorProps {
  readonly rules: readonly ViewFilterRule[];

  /** The local schema's properties, offered as suggestions - never as a bound. */
  readonly schema: readonly PropertyDefinition[];

  readonly onChange: (rules: readonly ViewFilterRule[]) => void;

  /** Query views span readable containers; ordinary views filter only their own children. */
  readonly scope?: 'query' | 'container';
}

export function FilterRulesEditor(props: FilterRulesEditorProps): ReactNode {
  const { rules, schema, onChange, scope = 'query' } = props;
  const listId = useId();

  function replace(index: number, changes: Partial<ViewFilterRule>): void {
    onChange(rules.map((rule, position) => (position === index ? { ...rule, ...changes } : rule)));
  }

  return (
    <div className="flex flex-col gap-2">
      <Text variant="note" tone="muted" as="p">
        {scope === 'query'
          ? 'Filters run across every container you can read, joined with AND. A property here is a key that may live in other containers, so it is typed rather than picked.'
          : 'Filters are joined with AND and hide children from this view only. Other views keep their own filters.'}
      </Text>

      <datalist id={listId}>
        {schema.map((property) => (
          <option key={property.key} value={property.key}>
            {property.label}
          </option>
        ))}
      </datalist>

      {rules.map((rule, index) => {
        const known = OPERATORS.some((operator) => operator.value === rule.operator);

        return (
          // The index is the identity here: rules have no ids, and reordering is not offered, so
          // position is stable for the life of the row.
          <div key={index} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
            <Field label="Property">
              {(control) => (
                <Input
                  {...control}
                  list={listId}
                  value={rule.property}
                  onChange={(event) => {
                    replace(index, { property: event.target.value });
                  }}
                />
              )}
            </Field>

            <Field label="Condition">
              {(control) => (
                <select
                  {...control}
                  value={rule.operator}
                  onChange={(event) => {
                    replace(index, { operator: event.target.value });
                  }}
                  className={cn(
                    'w-full border border-divider bg-background px-3 py-2 font-body text-base text-foreground',
                  )}
                >
                  {OPERATORS.map((operator) => (
                    <option key={operator.value} value={operator.value}>
                      {operator.label}
                    </option>
                  ))}
                  {/* A token from a newer build: preserved and named, never rewritten. */}
                  {known ? null : <option value={rule.operator}>{rule.operator}</option>}
                </select>
              )}
            </Field>

            <Field
              label="Value"
              {...(DAY_OPERATORS.has(rule.operator)
                ? { hint: "'today', or a date written 2026-08-15" }
                : rule.operator === 'within-next'
                  ? { hint: 'A number of days, 1 to 365' }
                  : {})}
            >
              {(control) => (
                <Input
                  {...control}
                  value={rule.value}
                  onChange={(event) => {
                    replace(index, { value: event.target.value });
                  }}
                />
              )}
            </Field>

            <Button
              variant="icon"
              aria-label={`Remove the filter on ${rule.property.length > 0 ? rule.property : 'this property'}`}
              onClick={() => {
                onChange(rules.filter((_, position) => position !== index));
              }}
            >
              <Icon icon={Trash2} size="sm" />
            </Button>
          </div>
        );
      })}

      <div>
        <Button
          variant="secondary"
          onClick={() => {
            onChange([...rules, { property: '', operator: 'equals', value: '' }]);
          }}
        >
          Add a filter
        </Button>
      </div>
    </div>
  );
}
