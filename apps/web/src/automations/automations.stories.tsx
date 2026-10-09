import { within } from '@testing-library/dom';
import type { AutomationRuleResponse, AutomationRunResponse } from '@nix/api-client';
import { Field, Input } from '@nix/ui';
import { useState, type ReactElement } from 'react';
import { MemoryRouter } from 'react-router';

import { emptyDraft, validateDraft, type AutomationDraft } from './automation-draft';
import { AutomationEditor, type ItemPickerProps } from './automation-editor';
import { AutomationList } from './automation-list';
import { AutomationRunLog } from './automation-run-log';

export default { title: 'Nix/Automations', parameters: { layout: 'padded' } };

const noop = (): void => undefined;

/** A stand-in for the searching item picker, which needs a server. */
function pickerStandIn(props: ItemPickerProps): ReactElement {
  return (
    <Field label={props.label} {...(props.hint === undefined ? {} : { hint: props.hint })}>
      {(control) => (
        <Input
          {...control}
          value={props.value ?? ''}
          placeholder="An item id"
          onChange={(event) => {
            props.onChange(event.currentTarget.value === '' ? null : event.currentTarget.value);
          }}
        />
      )}
    </Field>
  );
}

function Editor({
  start,
  showErrors = false,
}: {
  readonly start: AutomationDraft;
  readonly showErrors?: boolean;
}): ReactElement {
  const [draft, setDraft] = useState(start);
  return (
    <AutomationEditor
      draft={draft}
      onChange={setDraft}
      errors={showErrors ? validateDraft(draft) : {}}
      properties={[
        {
          key: 'status',
          label: 'Status',
          type: 'select',
          options: ['Open', 'Done'],
          required: false,
          expression: null,
          aggregate: null,
          source: null,
        },
        {
          key: 'due_date',
          label: 'Due',
          type: 'due_date',
          options: [],
          required: false,
          expression: null,
          aggregate: null,
          source: null,
        },
      ]}
      renderItemPicker={pickerStandIn}
      busy={false}
      submitLabel="Create automation"
      onSubmit={noop}
      onCancel={noop}
    />
  );
}

export const NewSchedule = {
  render: (): ReactElement => <Editor start={emptyDraft(null)} />,
};

export const PropertyChangeWithConditions = {
  render: (): ReactElement => {
    const base = emptyDraft('11111111-1111-4111-8111-111111111111');
    return (
      <Editor
        start={{
          ...base,
          name: 'Close out',
          property: {
            key: 'status',
            from: { mode: 'any', value: { type: 'text', text: '' } },
            to: { mode: 'value', value: { type: 'text', text: 'Done' } },
          },
          conditions: [{ key: 'due_date', op: 'is_not_empty', value: { type: 'text', text: '' } }],
          actions: [
            { kind: 'notify', title: 'Closed {item.title}', body: '' },
            {
              kind: 'set_property',
              target: 'triggering_item',
              targetItemId: null,
              key: 'status',
              clear: false,
              value: { type: 'text', text: 'Open' },
            },
          ],
        }}
      />
    );
  },
};

export const WithErrors = {
  render: (): ReactElement => <Editor start={{ ...emptyDraft(null), actions: [] }} showErrors />,
};

const rules: readonly AutomationRuleResponse[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    workspaceId: '00000000-0000-4000-8000-000000000001',
    name: 'Weekly review',
    enabled: true,
    scopeItemId: null,
    trigger: { type: 'schedule', freq: 'weekly', interval: 1, weekdays: ['fr'], time: '16:00' },
    conditions: [],
    actions: [{ type: 'notify', title: 'Weekly review', body: '' }],
    revision: 3,
    consecutiveFailures: 0,
    disabledReason: null,
    lastRunAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
    createdAt: '2026-09-01T09:00:00Z',
    updatedAt: '2026-09-01T09:00:00Z',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    workspaceId: '00000000-0000-4000-8000-000000000001',
    name: 'Chase overdue tasks',
    enabled: false,
    scopeItemId: null,
    trigger: { type: 'date_arrives', key: 'due_date', offsetMinutes: -1440, time: '09:00' },
    conditions: [],
    actions: [{ type: 'notify', title: '{item.title} is due tomorrow', body: '' }],
    revision: 9,
    consecutiveFailures: 5,
    disabledReason: 'repeated_failures',
    lastRunAt: null,
    createdAt: '2026-09-01T09:00:00Z',
    updatedAt: '2026-09-01T09:00:00Z',
  },
];

export const List = {
  render: (): ReactElement => (
    <MemoryRouter>
      <AutomationList
        rules={rules}
        hrefFor={(rule) => `/automations?rule=${rule.id}`}
        onToggle={noop}
        pending={new Set()}
        toggleErrors={{}}
      />
    </MemoryRouter>
  ),
};

const runs: readonly AutomationRunResponse[] = [
  {
    id: '33333333-3333-4333-8333-333333333331',
    ruleId: rules[0]?.id ?? '',
    itemId: null,
    origin: 'schedule',
    depth: 0,
    status: 'succeeded',
    reason: null,
    createdAt: '2026-09-26T16:00:00Z',
  },
  {
    id: '33333333-3333-4333-8333-333333333332',
    ruleId: rules[0]?.id ?? '',
    itemId: '44444444-4444-4444-8444-444444444444',
    origin: 'property',
    depth: 0,
    status: 'skipped',
    reason: 'conditions_unmet',
    createdAt: '2026-09-25T10:00:00Z',
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    ruleId: rules[0]?.id ?? '',
    itemId: null,
    origin: 'manual',
    depth: 0,
    status: 'failed',
    reason: 'set_property.target_not_found',
    createdAt: '2026-09-24T10:00:00Z',
  },
];

export const RunLog = {
  render: (): ReactElement => (
    <MemoryRouter>
      <AutomationRunLog
        status="ready"
        runs={runs}
        error={null}
        hasMore
        loadingMore={false}
        onLoadMore={noop}
        onRetry={noop}
        itemHref={(itemId) => `/?item=${itemId}`}
      />
    </MemoryRouter>
  ),
};

export const RunLogEmpty = {
  render: (): ReactElement => (
    <MemoryRouter>
      <AutomationRunLog
        status="ready"
        runs={[]}
        error={null}
        hasMore={false}
        loadingMore={false}
        onLoadMore={noop}
        onRetry={noop}
        itemHref={(itemId) => `/?item=${itemId}`}
      />
    </MemoryRouter>
  ),
};

export const PhoneSchedule = {
  ...NewSchedule,
  parameters: { viewport: { defaultViewport: 'mobile1' } },
};
export const PhoneList = { ...List, parameters: { viewport: { defaultViewport: 'mobile1' } } };
export const DarkPhoneSchedule = { ...PhoneSchedule, globals: { ground: 'dark' } };
export const DarkPhoneList = { ...PhoneList, globals: { ground: 'dark' } };

function checkNarrowAutomation({ canvasElement }: { readonly canvasElement: HTMLElement }): void {
  const region = within(canvasElement).getByRole('region', { name: 'Narrow automation' });
  if (region.scrollWidth > region.clientWidth) {
    throw new Error('Automation fields and rule controls must fit within a narrow pane.');
  }
}

export const TinySchedule = {
  render: (): ReactElement => (
    <section aria-label="Narrow automation" className="w-64 max-w-full">
      <Editor start={emptyDraft(null)} />
    </section>
  ),
  play: checkNarrowAutomation,
};
export const TinyLongRule = {
  render: (): ReactElement => (
    <MemoryRouter>
      <section aria-label="Narrow automation" className="w-64 max-w-full">
        <AutomationList
          rules={rules.map((rule) => ({ ...rule, name: 'ReviewTheWeek'.repeat(12) }))}
          hrefFor={(rule) => `/automations?rule=${rule.id}`}
          onToggle={noop}
          pending={new Set()}
          toggleErrors={{}}
        />
      </section>
    </MemoryRouter>
  ),
  play: checkNarrowAutomation,
};
export const DarkTinySchedule = { ...TinySchedule, globals: { ground: 'dark' } };
export const DarkTinyLongRule = { ...TinyLongRule, globals: { ground: 'dark' } };
