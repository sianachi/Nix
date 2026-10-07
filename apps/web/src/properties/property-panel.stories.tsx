import { useState, type ReactNode } from 'react';

import type { Item, PropertyDefinition } from '../views/core/container-model';
import { PropertyPanel } from './property-panel';

export default { title: 'Nix/Properties/Item details', parameters: { layout: 'padded' } };

const definitions: readonly PropertyDefinition[] = [
  { key: 'status', label: 'Status', type: 'select', options: ['Todo', 'Doing'], required: true },
  { key: 'estimate', label: 'Estimate', type: 'number', options: [], required: false },
  { key: 'done', label: 'Done', type: 'checkbox', options: [], required: false },
  { key: 'owner', label: 'Owner', type: 'text', options: [], required: false },
  { key: 'due', label: 'Due date', type: 'date', options: [], required: false },
];

function Example({
  empty = false,
  disabled = false,
}: {
  readonly empty?: boolean;
  readonly disabled?: boolean;
}): ReactNode {
  const [values, setValues] = useState<Record<string, unknown>>(
    empty ? {} : { status: 'Doing', estimate: 0, done: false },
  );
  const item: Item = {
    id: '11111111-1111-4111-8111-111111111111',
    workspaceId: '22222222-2222-4222-8222-222222222222',
    parentId: null,
    title: 'Launch checklist',
    type: 'note',
    lifecycleState: 'active',
    hasChildren: false,
    seq: 1,
    createdAt: '2026-10-06T10:00:00Z',
    updatedAt: '2026-10-06T10:00:00Z',
    properties: values,
  };
  return (
    <div className="w-full max-w-sm">
      <PropertyPanel
        compact
        item={item}
        properties={definitions}
        disabled={disabled}
        onChange={(changes) => {
          setValues({ ...values, ...changes });
          return Promise.resolve(null);
        }}
      />
    </div>
  );
}

export const Populated = { render: (): ReactNode => <Example /> };
export const OptionalFields = { render: (): ReactNode => <Example empty /> };
export const ReadOnly = { render: (): ReactNode => <Example disabled /> };
export const DarkPopulated = { ...Populated, globals: { ground: 'dark' } };
