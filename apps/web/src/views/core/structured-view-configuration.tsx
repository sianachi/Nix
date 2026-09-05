import { Button, Field, Icon, Select, Text, focusRing } from '@nix/ui';
import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';

import { InteractiveFormEditor } from '../form/interactive-form-editor';
import { FilterRulesEditor } from '../query/filter-rules-editor';
import type { PropertyDefinition, View } from './container-model';
import { LineListInput } from './line-list-input';
import { findViewKind } from './view-kinds';

export interface StructuredViewConfigurationProps {
  readonly view: View;
  readonly fields: readonly PropertyDefinition[];
  readonly onChange: (view: View) => void;
  /** Creation recipes deliberately expose columns only for the kinds whose wizard promises them. */
  readonly showColumns?: boolean | undefined;
  /** Creation recipes deliberately expose sorting only where their wizard promises it. */
  readonly showSortAndFilters?: boolean | undefined;
  /** A Smart-list wizard owns its starter choices and passes false to avoid a second filter editor. */
  readonly showKindFilters?: boolean | undefined;
}

/**
 * The shared field controls for a stored structured view.
 *
 * Creation, template editing, and future view setup all edit the same record. Keeping the controls
 * here means a new configuration field is taught to one surface rather than copied between them.
 */
export function StructuredViewConfiguration({
  view,
  fields,
  onChange,
  showColumns = !['query', 'interactive_form'].includes(view.kind),
  showSortAndFilters = !['form', 'interactive_form', 'query'].includes(view.kind),
  showKindFilters = true,
}: StructuredViewConfigurationProps): ReactNode {
  const descriptor = findViewKind(view.kind);

  return (
    <>
      {descriptor?.configures.map((configuration) => {
        const usable = fields.filter(configuration.accepts);
        return (
          <Field
            key={configuration.field}
            label={configuration.label}
            hint={usable.length === 0 ? configuration.emptyHint : configuration.hint}
          >
            {(control) => (
              <Select
                {...control}
                value={view[configuration.field] ?? ''}
                onChange={(event) => {
                  const value = event.target.value;
                  onChange({
                    ...view,
                    ...configuration.clears,
                    [configuration.field]: value.length === 0 ? null : value,
                  });
                }}
              >
                <option value="">{configuration.emptyChoice}</option>
                {usable.map((field) => (
                  <option key={field.key} value={field.key}>
                    {field.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        );
      })}

      {descriptor?.chooses.map((choice) => (
        <Field key={choice.field} label={choice.label} hint={choice.hint}>
          {(control) => (
            <Select
              {...control}
              value={view[choice.field] ?? choice.fallback}
              onChange={(event) => {
                onChange({ ...view, [choice.field]: event.target.value });
              }}
            >
              {choice.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ))}

      {view.kind === 'board' ? (
        <Field label="Column order" hint="One select option per line.">
          {(control) => (
            <LineListInput
              {...control}
              rows={3}
              value={view.groupOrder}
              onChange={(groupOrder) => {
                onChange({
                  ...view,
                  groupOrder,
                });
              }}
            />
          )}
        </Field>
      ) : null}

      {view.kind === 'calendar' || view.kind === 'timeline' ? (
        <Field label={view.kind === 'calendar' ? 'Initial calendar view' : 'Initial time scale'}>
          {(control) => (
            <Select
              {...control}
              value={view.mode ?? (view.kind === 'calendar' ? 'week' : 'month')}
              onChange={(event) => {
                onChange({ ...view, mode: event.target.value });
              }}
            >
              {view.kind === 'calendar' ? <option value="day">Day</option> : null}
              <option value="week">Week</option>
              <option value="month">Month</option>
              {view.kind === 'timeline' ? <option value="quarter">Quarter</option> : null}
            </Select>
          )}
        </Field>
      ) : null}

      {showColumns ? <ViewColumns view={view} fields={fields} onChange={onChange} /> : null}

      {showSortAndFilters ? (
        <>
          <SortChoice view={view} fields={fields} onChange={onChange} />
          <FilterRulesEditor
            scope="container"
            rules={view.filters}
            schema={fields}
            onChange={(filters) => {
              onChange({ ...view, filters: [...filters] });
            }}
          />
        </>
      ) : showKindFilters && descriptor?.editsFilters === true ? (
        <FilterRulesEditor
          rules={view.filters}
          schema={fields}
          onChange={(filters) => {
            onChange({ ...view, filters: [...filters] });
          }}
        />
      ) : null}

      {view.kind === 'interactive_form' && view.interactiveForm != null ? (
        <InteractiveFormEditor
          form={view.interactiveForm}
          schema={fields}
          itemId={null}
          viewId={view.id}
          showPublishing={false}
          onChange={(interactiveForm) => {
            onChange({ ...view, interactiveForm });
          }}
        />
      ) : null}
    </>
  );
}

function SortChoice({
  view,
  fields,
  onChange,
}: {
  readonly view: View;
  readonly fields: readonly PropertyDefinition[];
  readonly onChange: (view: View) => void;
}): ReactNode {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Sort by">
        {(control) => (
          <Select
            {...control}
            value={view.sortBy ?? ''}
            onChange={(event) => {
              onChange({
                ...view,
                sortBy: event.target.value.length === 0 ? null : event.target.value,
              });
            }}
          >
            <option value="">No sorting</option>
            <option value="title">Title</option>
            {fields.map((field) => (
              <option key={field.key} value={field.key}>
                {field.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <label className="flex items-center gap-2 self-end py-2 text-base">
        <input
          type="checkbox"
          checked={view.sortDescending}
          disabled={view.sortBy === null}
          className={focusRing}
          onChange={(event) => {
            onChange({ ...view, sortDescending: event.target.checked });
          }}
        />
        Descending order
      </label>
    </div>
  );
}

function ViewColumns({
  view,
  fields,
  onChange,
}: {
  readonly view: View;
  readonly fields: readonly PropertyDefinition[];
  readonly onChange: (view: View) => void;
}): ReactNode {
  const available = [
    { key: 'title', label: 'Title' },
    ...fields.map((field) => ({ key: field.key, label: field.label })),
  ];
  const selected = view.columns.filter((key) => available.some((field) => field.key === key));
  const unselected = available.filter((field) => !selected.includes(field.key));

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-semibold">Visible fields and order</legend>
      {selected.map((key, index) => {
        const label = available.find((field) => field.key === key)?.label ?? key;
        return (
          <div key={key} className="flex items-center gap-2 rounded-md bg-background px-2 py-1">
            <Text variant="bodySmall" className="flex-1">
              {label}
            </Text>
            <Button
              variant="icon"
              aria-label={`Move ${label} earlier`}
              disabled={index === 0}
              onClick={() => {
                onChange({ ...view, columns: move(selected, index, -1) });
              }}
            >
              <Icon icon={ChevronUp} size="sm" />
            </Button>
            <Button
              variant="icon"
              aria-label={`Move ${label} later`}
              disabled={index === selected.length - 1}
              onClick={() => {
                onChange({ ...view, columns: move(selected, index, 1) });
              }}
            >
              <Icon icon={ChevronDown} size="sm" />
            </Button>
            <Button
              variant="icon"
              aria-label={`Hide ${label}`}
              onClick={() => {
                onChange({ ...view, columns: selected.filter((entry) => entry !== key) });
              }}
            >
              <Icon icon={Trash2} size="sm" />
            </Button>
          </div>
        );
      })}
      {unselected.length === 0 ? null : (
        <Field label="Add visible field">
          {(control) => (
            <Select
              {...control}
              value=""
              onChange={(event) => {
                if (event.target.value.length === 0) return;
                onChange({ ...view, columns: [...selected, event.target.value] });
              }}
            >
              <option value="">Choose a field</option>
              {unselected.map((field) => (
                <option key={field.key} value={field.key}>
                  {field.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
    </fieldset>
  );
}

function move<T>(entries: readonly T[], index: number, by: number): T[] {
  const next = [...entries];
  const target = index + by;
  const entry = next[index];
  const displaced = next[target];
  if (entry === undefined || displaced === undefined) return next;
  next[index] = displaced;
  next[target] = entry;
  return next;
}
