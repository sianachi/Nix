import { Blueprint, Button, Field, Input, Select, Text } from '@nix/ui';
import { items as coreItems } from '@nix/api-client';
import { useEffect, useState, type ReactNode } from 'react';

import { useApiClient } from '../api/api-client-provider';
import { useWorkspaceAssignablePrincipals } from '../workspaces/use-workspace-assignable-principals';
import type { TreeItem } from '../items/use-workspace-tree';
import { TemplateItemPicker } from './template-item-picker';
import type {
  TemplateInitialization,
  TemplateInitializationRule,
  TemplateInput,
  TemplateItem,
  TemplateReferenceRule,
} from './template-api';

interface TargetOption {
  readonly sourceId: string;
  readonly itemTitle: string;
  readonly propertyKey: string;
  readonly label: string;
  readonly type: string;
  readonly options: readonly string[];
}

export function TemplateInitializationEditor({
  root,
  initialization,
  itemOptions,
  onChange,
}: {
  readonly root: TemplateItem;
  readonly initialization: TemplateInitialization;
  readonly itemOptions: readonly TreeItem[];
  readonly onChange: (initialization: TemplateInitialization) => void;
}): ReactNode {
  const members = useWorkspaceAssignablePrincipals();
  const client = useApiClient();
  const [referenceLabels, setReferenceLabels] = useState<Readonly<Record<string, string>>>({});
  const [timeRules, setTimeRules] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        initialization.rules.flatMap((rule) =>
          rule.kind === 'relativeDate' && rule.timeOfDay !== null ? [targetKey(rule)] : [],
        ),
      ),
  );
  const targets = collectTargets(root);

  useEffect(() => {
    const ids = [...new Set(initialization.references.map((reference) => reference.sourceItemId))];
    const active = new AbortController();
    const labels: Record<string, string> = {};
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (!active.signal.aborted) {
        const index = cursor++;
        const id = ids[index];
        if (id === undefined) return;
        try {
          const item = await client.query(coreItems.itemById(id), {
            signal: active.signal,
            forceRefresh: true,
          });
          labels[id] = item.title || 'Untitled item';
        } catch {
          labels[id] = 'Unavailable item';
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(8, ids.length) }, () => worker())).then(() => {
      if (!active.signal.aborted) setReferenceLabels(labels);
    });
    return () => {
      active.abort();
    };
  }, [client, initialization.references]);

  function updateInput(index: number, next: TemplateInput): void {
    const previous = initialization.inputs[index];
    const previousKey = previous?.key;
    const keyChanged = previousKey !== undefined && previousKey !== next.key;
    const typeChanged = previous !== undefined && previous.type !== next.type;
    onChange({
      ...initialization,
      inputs: initialization.inputs.map((input, at) => (at === index ? next : input)),
      rules: initialization.rules
        .filter((rule) => {
          if (!typeChanged || !('inputKey' in rule) || rule.inputKey !== previousKey) return true;
          if (rule.kind === 'relativeDate') return next.type === 'date';
          const target = targets.find((entry) => targetKey(entry) === targetKey(rule));
          return target !== undefined && compatibleInput(next.type, target.type);
        })
        .map((rule) =>
          keyChanged && 'inputKey' in rule && rule.inputKey === previousKey
            ? { ...rule, inputKey: next.key }
            : rule,
        ),
      references: initialization.references.map((reference) =>
        reference.policy === 'replace' && reference.inputKey === previousKey
          ? next.type === 'item'
            ? { ...reference, inputKey: next.key }
            : { sourceItemId: reference.sourceItemId, policy: 'omit' }
          : reference,
      ),
    });
  }

  function removeInput(index: number): void {
    const removed = initialization.inputs[index];
    if (removed === undefined) return;
    const inputs = initialization.inputs.filter((_input, at) => at !== index);
    const rules = initialization.rules.filter(
      (rule) => !('inputKey' in rule) || rule.inputKey !== removed.key,
    );
    const references = initialization.references.map((reference) =>
      reference.policy === 'replace' && reference.inputKey === removed.key
        ? { sourceItemId: reference.sourceItemId, policy: 'omit' as const }
        : reference,
    );
    onChange({ ...initialization, inputs, rules, references });
  }

  function addInput(): void {
    if (initialization.inputs.length >= 100) return;
    const used = new Set(initialization.inputs.map((input) => input.key));
    let number = initialization.inputs.length + 1;
    while (used.has(`answer_${String(number)}`)) number += 1;
    onChange({
      ...initialization,
      inputs: [
        ...initialization.inputs,
        {
          key: `answer_${String(number)}`,
          label: `Answer ${String(number)}`,
          type: 'text',
          required: false,
          defaultValue: null,
        },
      ],
    });
  }

  function updateRule(index: number, next: TemplateInitializationRule): void {
    onChange({
      ...initialization,
      rules: initialization.rules.map((rule, at) => (at === index ? next : rule)),
    });
  }

  function addRule(): void {
    if (initialization.rules.length + initialization.references.length >= 2_000) return;
    const available = targets.find(
      (target) => !initialization.rules.some((rule) => targetKey(rule) === targetKey(target)),
    );
    if (available === undefined) return;
    onChange({
      ...initialization,
      rules: [
        ...initialization.rules,
        { sourceId: available.sourceId, propertyKey: available.propertyKey, kind: 'keep' },
      ],
    });
  }

  function addReference(reference: TemplateReferenceRule): void {
    onChange({
      ...initialization,
      references: initialization.references.map((entry) =>
        entry.sourceItemId === reference.sourceItemId ? reference : entry,
      ),
    });
  }

  return (
    <section className="flex flex-col gap-4" aria-labelledby="template-setup-heading">
      <div>
        <Text variant="h2" as="h2" id="template-setup-heading">
          Setup and portability
        </Text>
        <Text variant="bodySmall" tone="muted">
          Ask for the values a new item needs, then choose what happens to each captured field. Use{' '}
          <code>{'{{input_key}}'}</code> in a title or prose body to bind text safely.
        </Text>
      </div>

      <Blueprint className="flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <Text variant="h3" as="h3">
              Questions
            </Text>
            <Text variant="caption" tone="muted">
              Text, date, workspace member, or item.
            </Text>
          </div>
          <Button
            variant="secondary"
            disabled={initialization.inputs.length >= 100}
            onClick={addInput}
          >
            Add question
          </Button>
        </div>
        {initialization.inputs.length === 0 ? (
          <Text variant="caption" tone="muted">
            No setup questions yet.
          </Text>
        ) : null}
        {initialization.inputs.map((input, index) => (
          <div
            key={index}
            className="grid gap-3 rounded-md border border-divider p-3 md:grid-cols-[1fr_1fr_auto]"
          >
            <Field
              label="Question label"
              required
              error={input.label.trim().length === 0 ? 'Add a label.' : null}
            >
              {(control) => (
                <Input
                  {...control}
                  value={input.label}
                  maxLength={120}
                  onChange={(event) => {
                    updateInput(index, { ...input, label: event.target.value });
                  }}
                />
              )}
            </Field>
            <Field label="Input key" hint="Used in placeholders, for example {{project_name}}.">
              {(control) => (
                <Input
                  {...control}
                  value={input.key}
                  maxLength={64}
                  onChange={(event) => {
                    updateInput(index, { ...input, key: event.target.value });
                  }}
                />
              )}
            </Field>
            <div className="flex items-end gap-3">
              <Field label="Answer type">
                {(control) => (
                  <Select
                    {...control}
                    value={input.type}
                    onChange={(event) => {
                      const type = event.target.value as TemplateInput['type'];
                      const next = { ...input, type, defaultValue: null };
                      updateInput(index, next);
                    }}
                  >
                    <option value="text">Text</option>
                    <option value="date">Date</option>
                    <option value="member">Workspace member</option>
                    <option value="item">Item</option>
                  </Select>
                )}
              </Field>
              <Button
                variant="secondary"
                onClick={() => {
                  removeInput(index);
                }}
              >
                Remove
              </Button>
            </div>
            <label className="flex items-center gap-2 text-sm md:col-span-3">
              <input
                type="checkbox"
                checked={input.required}
                onChange={(event) => {
                  updateInput(index, { ...input, required: event.target.checked });
                }}
              />
              Required
            </label>
            <div className="md:col-span-3">
              {input.type === 'member' ? (
                <Input
                  aria-label="Search workspace members"
                  value={members.query}
                  placeholder="Search workspace members"
                  onChange={(event) => {
                    members.setQuery(event.target.value);
                  }}
                />
              ) : null}
              <InputDefaultEditor
                input={input}
                itemOptions={itemOptions}
                members={members.principals}
                onChange={(defaultValue) => {
                  updateInput(index, withOptionalDefault(input, defaultValue));
                }}
              />
              {input.type === 'member' && members.hasMore ? (
                <Button
                  variant="secondary"
                  disabled={members.loadingMore}
                  onClick={() => void members.loadMore()}
                >
                  {members.loadingMore ? 'Loading members' : 'Load more members'}
                </Button>
              ) : null}
            </div>
          </div>
        ))}
      </Blueprint>

      <Blueprint className="flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <Text variant="h3" as="h3">
              Field rules
            </Text>
            <Text variant="caption" tone="muted">
              Unlisted fields keep ordinary values. Completion resets, due and start dates clear,
              and assignees clear unless a rule says otherwise.
            </Text>
          </div>
          <Button
            variant="secondary"
            disabled={
              targets.length === 0 ||
              initialization.rules.length + initialization.references.length >= 2_000
            }
            onClick={addRule}
          >
            Add field rule
          </Button>
        </div>
        {initialization.rules.map((rule, index) => {
          const currentTarget = targets.find((target) => targetKey(target) === targetKey(rule));
          return (
            <div
              key={targetKey(rule)}
              className="grid gap-3 rounded-md border border-divider p-3 md:grid-cols-2"
            >
              <Field label="Item and field">
                {(control) => (
                  <Select
                    {...control}
                    value={targetKey(rule)}
                    onChange={(event) => {
                      const target = targets.find(
                        (entry) => targetKey(entry) === event.target.value,
                      );
                      if (target !== undefined) {
                        updateRule(index, {
                          sourceId: target.sourceId,
                          propertyKey: target.propertyKey,
                          kind: 'keep',
                        });
                      }
                    }}
                  >
                    {targets.map((target) => (
                      <option key={targetKey(target)} value={targetKey(target)}>
                        {target.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="When this item is created">
                {(control) => (
                  <Select
                    {...control}
                    value={rule.kind}
                    onChange={(event) => {
                      const next = createRule(
                        currentTarget ?? targetFromRule(rule),
                        event.target.value,
                        initialization.inputs,
                      );
                      updateRule(index, next);
                      if (next.kind !== 'relativeDate') {
                        setTimeRules(
                          (current) =>
                            new Set([...current].filter((key) => key !== targetKey(next))),
                        );
                      }
                    }}
                  >
                    <option value="keep">Keep the captured value</option>
                    <option value="clear">Clear the value</option>
                    <option value="set">Set a fixed value</option>
                    <option value="input">Use an answer</option>
                    {availableDateInputs(initialization.inputs).length > 0 ? (
                      <option value="relativeDate">Set a date relative to an answer</option>
                    ) : null}
                  </Select>
                )}
              </Field>
              <div className="md:col-span-2">
                {rule.kind === 'set' ? (
                  <RuleValueEditor
                    target={currentTarget}
                    value={rule.value}
                    itemOptions={itemOptions}
                    onChange={(value) => {
                      updateRule(index, { ...rule, value: requiredSetValue(value) });
                    }}
                  />
                ) : null}
                {rule.kind === 'input' ? (
                  <InputRuleEditor
                    rule={rule}
                    target={currentTarget}
                    inputs={initialization.inputs}
                    onChange={(inputKey) => {
                      updateRule(index, { ...rule, inputKey });
                    }}
                  />
                ) : null}
                {rule.kind === 'relativeDate' ? (
                  <RelativeDateRuleEditor
                    rule={rule}
                    inputs={initialization.inputs}
                    useTime={timeRules.has(targetKey(rule))}
                    onChange={(next) => {
                      updateRule(index, next);
                    }}
                    onUseTimeChange={(enabled) => {
                      setTimeRules((current) => {
                        const next = new Set(current);
                        if (enabled) next.add(targetKey(rule));
                        else next.delete(targetKey(rule));
                        return next;
                      });
                      updateRule(index, {
                        ...rule,
                        ...(enabled
                          ? { timeOfDay: '09:00', timeZone: 'Europe/London' }
                          : { timeOfDay: null, timeZone: null }),
                      });
                    }}
                  />
                ) : null}
                <Button
                  variant="secondary"
                  className="mt-3"
                  onClick={() => {
                    onChange({
                      ...initialization,
                      rules: initialization.rules.filter((_entry, at) => at !== index),
                    });
                  }}
                >
                  Remove field rule
                </Button>
              </div>
            </div>
          );
        })}
      </Blueprint>

      <Blueprint className="flex flex-col gap-3 p-4">
        <div>
          <Text variant="h3" as="h3">
            External item links
          </Text>
          <Text variant="caption" tone="muted">
            Choose whether each captured outside link stays, is cleared, or points to a replacement.
          </Text>
        </div>
        {initialization.references.length === 0 ? (
          <Text variant="caption" tone="muted">
            No external links were captured.
          </Text>
        ) : null}
        {initialization.references.map((reference) => (
          <div
            key={reference.sourceItemId}
            className="grid gap-3 rounded-md border border-divider p-3 md:grid-cols-2"
          >
            <Text variant="bodySmall" className="self-center">
              {referenceLabels[reference.sourceItemId] ?? 'Loading linked item…'}
            </Text>
            <Field label="On creation">
              {(control) => (
                <Select
                  {...control}
                  value={reference.policy}
                  onChange={(event) => {
                    const policy = event.target.value as TemplateReferenceRule['policy'];
                    addReference(
                      policy === 'replace'
                        ? {
                            sourceItemId: reference.sourceItemId,
                            policy,
                            inputKey: firstItemInput(initialization.inputs),
                          }
                        : { sourceItemId: reference.sourceItemId, policy },
                    );
                  }}
                >
                  <option value="omit">Clear the external link</option>
                  <option value="retain">Keep the link if authorized</option>
                  <option
                    value="replace"
                    disabled={!initialization.inputs.some((input) => input.type === 'item')}
                  >
                    Choose a replacement item
                  </option>
                </Select>
              )}
            </Field>
            {reference.policy === 'replace' ? (
              <Field label="Replacement item" className="md:col-span-2">
                {(control) => (
                  <Select
                    {...control}
                    value={reference.inputKey}
                    onChange={(event) => {
                      addReference({ ...reference, inputKey: event.target.value });
                    }}
                  >
                    <option value="">Choose an item answer</option>
                    {initialization.inputs
                      .filter((input) => input.type === 'item')
                      .map((input) => (
                        <option key={input.key} value={input.key}>
                          {input.label}
                        </option>
                      ))}
                  </Select>
                )}
              </Field>
            ) : null}
            <Text variant="caption" tone="muted" className="md:col-span-2">
              {reference.policy === 'retain'
                ? 'The applying workspace must authorize this linked item.'
                : reference.policy === 'replace'
                  ? 'The selected item answer replaces this link.'
                  : 'The external link is omitted from created bodies.'}
            </Text>
          </div>
        ))}
      </Blueprint>
      {members.status === 'error' &&
      initialization.inputs.some((input) => input.type === 'member') ? (
        <div className="flex items-center gap-2">
          <Text as="p" role="alert" variant="caption">
            Assignable principals could not be loaded.
          </Text>
          <Button variant="secondary" onClick={() => void members.reload()}>
            Retry member loading
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function InputDefaultEditor({
  input,
  itemOptions,
  members,
  onChange,
}: {
  readonly input: TemplateInput;
  readonly itemOptions: readonly TreeItem[];
  readonly members: readonly { readonly principalId: string; readonly displayName: string }[];
  readonly onChange: (value: string | undefined) => void;
}): ReactNode {
  if (input.type === 'member') {
    return (
      <Field label="Default member" hint="Optional. Choose from workspace members.">
        {(control) => (
          <Select
            {...control}
            value={input.defaultValue ?? ''}
            onChange={(event) => {
              onChange(event.target.value || undefined);
            }}
            disabled={members.length === 0}
          >
            <option value="">No default</option>
            {members.map((member) => (
              <option key={member.principalId} value={member.principalId}>
                {member.displayName}
              </option>
            ))}
          </Select>
        )}
      </Field>
    );
  }
  if (input.type === 'item') {
    return (
      <TemplateItemPicker
        label="Default item"
        hint="Optional. Search for an accessible item."
        value={input.defaultValue ?? ''}
        loadedItems={itemOptions}
        onChange={(value) => {
          onChange(value ?? undefined);
        }}
      />
    );
  }
  return (
    <Field label="Default answer" hint="Optional. A person can change it before preview.">
      {(control) => (
        <Input
          {...control}
          type={input.type === 'date' ? 'date' : 'text'}
          value={input.defaultValue ?? ''}
          maxLength={4_096}
          onChange={(event) => {
            onChange(event.target.value.length === 0 ? undefined : event.target.value);
          }}
        />
      )}
    </Field>
  );
}

function InputRuleEditor({
  rule,
  target,
  inputs,
  onChange,
}: {
  readonly rule: Extract<TemplateInitializationRule, { kind: 'input' }>;
  readonly target: TargetOption | undefined;
  readonly inputs: readonly TemplateInput[];
  readonly onChange: (inputKey: string) => void;
}): ReactNode {
  const candidates = inputs.filter((input) => compatibleInput(input.type, target?.type));
  return (
    <Field
      label="Answer to use"
      error={candidates.length === 0 ? 'Add a compatible question first.' : null}
    >
      {(control) => (
        <Select
          {...control}
          value={rule.inputKey}
          disabled={candidates.length === 0}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        >
          <option value="">Choose an answer</option>
          {candidates.map((input) => (
            <option key={input.key} value={input.key}>
              {input.label}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

function RelativeDateRuleEditor({
  rule,
  inputs,
  useTime,
  onChange,
  onUseTimeChange,
}: {
  readonly rule: Extract<TemplateInitializationRule, { kind: 'relativeDate' }>;
  readonly inputs: readonly TemplateInput[];
  readonly useTime: boolean;
  readonly onChange: (rule: Extract<TemplateInitializationRule, { kind: 'relativeDate' }>) => void;
  readonly onUseTimeChange: (enabled: boolean) => void;
}): ReactNode {
  const dateInputs = availableDateInputs(inputs);
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 md:grid-cols-2">
        <Field
          label="Date answer"
          error={dateInputs.length === 0 ? 'Add a date question first.' : null}
        >
          {(control) => (
            <Select
              {...control}
              value={rule.inputKey}
              disabled={dateInputs.length === 0}
              onChange={(event) => {
                onChange({ ...rule, inputKey: event.target.value });
              }}
            >
              <option value="">Choose a date answer</option>
              {dateInputs.map((input) => (
                <option key={input.key} value={input.key}>
                  {input.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Days from that date" hint="Use a negative number for days before.">
          {(control) => (
            <Input
              {...control}
              type="number"
              min={-36_500}
              max={36_500}
              value={String(rule.offsetDays)}
              onChange={(event) => {
                onChange({ ...rule, offsetDays: Number(event.target.value) });
              }}
            />
          )}
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={useTime}
          onChange={(event) => {
            onUseTimeChange(event.target.checked);
          }}
        />
        Set a time and time zone
      </label>
      {useTime ? (
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Time">
            {(control) => (
              <Input
                {...control}
                type="time"
                value={rule.timeOfDay ?? '09:00'}
                onChange={(event) => {
                  onChange({
                    ...rule,
                    timeOfDay: event.target.value,
                    timeZone: rule.timeZone ?? 'Europe/London',
                  });
                }}
              />
            )}
          </Field>
          <Field label="Time zone" hint="Use an IANA time-zone name, such as Europe/London.">
            {(control) => (
              <Input
                {...control}
                value={rule.timeZone ?? 'Europe/London'}
                maxLength={128}
                onChange={(event) => {
                  onChange({
                    ...rule,
                    timeZone: event.target.value,
                    timeOfDay: rule.timeOfDay ?? '09:00',
                  });
                }}
              />
            )}
          </Field>
        </div>
      ) : null}
    </div>
  );
}

function RuleValueEditor({
  target,
  value,
  itemOptions,
  onChange,
}: {
  readonly target: TargetOption | undefined;
  readonly value: unknown;
  readonly itemOptions: readonly TreeItem[];
  readonly onChange: (value: unknown) => void;
}): ReactNode {
  const memberDirectory = useWorkspaceAssignablePrincipals();
  if (target?.type === 'multiselect' && target.options.length > 0) {
    const selected = Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string')
      : [];
    return (
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Fixed values</legend>
        {target.options.map((option) => (
          <label key={option} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selected.includes(option)}
              onChange={(event) => {
                onChange(
                  event.target.checked
                    ? [...selected, option]
                    : selected.filter((entry) => entry !== option),
                );
              }}
            />
            {option}
          </label>
        ))}
      </fieldset>
    );
  }
  if (target?.options.length) {
    return (
      <Field label="Fixed value">
        {(control) => (
          <Select
            {...control}
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          >
            <option value="">Choose a value</option>
            {target.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        )}
      </Field>
    );
  }
  if (
    target?.propertyKey === 'recurrence.until' ||
    target?.type.toLocaleLowerCase().includes('date')
  ) {
    return (
      <Field label="Fixed date">
        {(control) => (
          <Input
            {...control}
            type="date"
            value={typeof value === 'string' ? value.slice(0, 10) : ''}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
        )}
      </Field>
    );
  }
  if (target?.type === 'item') {
    return (
      <TemplateItemPicker
        label="Fixed item"
        value={typeof value === 'string' ? value : ''}
        loadedItems={itemOptions}
        onChange={(next) => {
          onChange(next ?? '');
        }}
      />
    );
  }
  if (target?.type === 'checkbox' || target?.type === 'completion') {
    return (
      <Field label="Fixed value">
        {(control) => (
          <Select
            {...control}
            value={typeof value === 'boolean' && value ? 'true' : 'false'}
            onChange={(event) => {
              onChange(event.target.value === 'true');
            }}
          >
            <option value="false">No</option>
            <option value="true">Yes</option>
          </Select>
        )}
      </Field>
    );
  }
  if (target?.type === 'assignee') {
    const principals = memberDirectory.principals;
    return (
      <Field
        label="Fixed assignee"
        error={
          memberDirectory.status === 'error' ? 'Assignable principals could not be loaded.' : null
        }
      >
        {(control) => (
          <div className="flex flex-col gap-2">
            <Input
              aria-label="Search workspace members"
              placeholder="Search workspace members"
              value={memberDirectory.query}
              onChange={(event) => {
                memberDirectory.setQuery(event.target.value);
              }}
            />
            <Select
              {...control}
              value={typeof value === 'string' ? value : ''}
              disabled={memberDirectory.status !== 'ready'}
              onChange={(event) => {
                onChange(event.target.value);
              }}
            >
              <option value="">Choose a workspace member</option>
              {principals.map((member) => (
                <option key={member.principalId} value={member.principalId}>
                  {member.displayName}
                </option>
              ))}
            </Select>
            {memberDirectory.hasMore ? (
              <Button
                variant="secondary"
                disabled={memberDirectory.loadingMore}
                onClick={() => void memberDirectory.loadMore()}
              >
                {memberDirectory.loadingMore ? 'Loading members' : 'Load more members'}
              </Button>
            ) : null}
          </div>
        )}
      </Field>
    );
  }
  if (target?.type === 'number' || target?.type === 'estimate') {
    return (
      <Field label="Fixed number">
        {(control) => (
          <Input
            {...control}
            type="number"
            value={typeof value === 'number' ? String(value) : ''}
            onChange={(event) => {
              onChange(Number(event.target.value));
            }}
          />
        )}
      </Field>
    );
  }
  if (target?.type === 'priority') {
    return (
      <Field label="Fixed priority">
        {(control) => (
          <Select
            {...control}
            value={typeof value === 'number' ? String(value) : ''}
            onChange={(event) => {
              onChange(Number(event.target.value));
            }}
          >
            <option value="">Choose priority</option>
            <option value="1">1 · Highest</option>
            <option value="2">2 · High</option>
            <option value="3">3 · Normal</option>
            <option value="4">4 · Low</option>
          </Select>
        )}
      </Field>
    );
  }
  return (
    <Field label="Fixed text">
      {(control) => (
        <Input
          {...control}
          value={typeof value === 'string' ? value : ''}
          maxLength={4_096}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      )}
    </Field>
  );
}

function collectTargets(root: TemplateItem): readonly TargetOption[] {
  const items: TemplateItem[] = [];
  const visit = (item: TemplateItem): void => {
    items.push(item);
    item.children.forEach(visit);
  };
  visit(root);
  return items.flatMap((item) => [
    ...(item.schema?.properties ?? [])
      .filter((property) => !['formula', 'rollup'].includes(property.type.toLocaleLowerCase()))
      .map((property) => ({
        sourceId: item.sourceId,
        itemTitle: item.title,
        propertyKey: property.key,
        label: `${item.title} · ${property.label}`,
        type: property.type,
        options: property.options,
      })),
    ...(item.recurrence == null
      ? []
      : [
          {
            sourceId: item.sourceId,
            itemTitle: item.title,
            propertyKey: 'recurrence.until',
            label: `${item.title} · Series end date`,
            type: 'date',
            options: [],
          },
        ]),
  ]);
}

function targetKey(target: { readonly sourceId: string; readonly propertyKey: string }): string {
  return `${target.sourceId}:${target.propertyKey}`;
}

function targetFromRule(rule: TemplateInitializationRule): TargetOption {
  return {
    sourceId: rule.sourceId,
    itemTitle: 'Selected item',
    propertyKey: rule.propertyKey,
    label: rule.propertyKey === 'recurrence.until' ? 'Series end date' : rule.propertyKey,
    type: rule.propertyKey === 'recurrence.until' ? 'date' : 'text',
    options: [],
  };
}

function createRule(
  target: TargetOption,
  kind: string,
  inputs: readonly TemplateInput[],
): TemplateInitializationRule {
  const base = { sourceId: target.sourceId, propertyKey: target.propertyKey };
  if (kind === 'clear') return { ...base, kind: 'clear' };
  if (kind === 'set') return { ...base, kind: 'set', value: '' };
  if (kind === 'input') {
    const candidate = inputs.find((input) => compatibleInput(input.type, target.type));
    return { ...base, kind: 'input', inputKey: candidate?.key ?? '' };
  }
  if (kind === 'relativeDate') {
    return {
      ...base,
      kind: 'relativeDate',
      inputKey: availableDateInputs(inputs)[0]?.key ?? '',
      offsetDays: 0,
      timeOfDay: null,
      timeZone: null,
    };
  }
  return { ...base, kind: 'keep' };
}

function compatibleInput(
  inputType: TemplateInput['type'],
  propertyType: string | undefined,
): boolean {
  if (propertyType === undefined) return inputType === 'text';
  const type = propertyType.toLocaleLowerCase();
  if (type.includes('date') || type.includes('time')) return inputType === 'date';
  if (type.includes('member') || type.includes('person') || type === 'assignee')
    return inputType === 'member';
  return type === 'text' && inputType === 'text';
}

function withOptionalDefault(input: TemplateInput, value: string | undefined): TemplateInput {
  return { ...input, defaultValue: value ?? null };
}

function requiredSetValue(
  value: unknown,
): Extract<TemplateInitializationRule, { kind: 'set' }>['value'] {
  return value ?? '';
}

function availableDateInputs(inputs: readonly TemplateInput[]): readonly TemplateInput[] {
  return inputs.filter((input) => input.type === 'date');
}

function firstItemInput(inputs: readonly TemplateInput[]): string {
  return inputs.find((input) => input.type === 'item')?.key ?? '';
}
