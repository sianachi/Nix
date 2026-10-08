import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderAt } from '../../render-with-router';
import { aView } from '../../view-fixture';
import { aContainer } from '../../container-fixture';
import type {
  EffectiveSchema,
  Item,
  PropertyDefinition,
  View,
} from '../../../views/core/container-model';
import { ChecklistView, resolveDoneProperty } from '../../../views/checklist/checklist-view';

function item(
  id: string,
  title: string,
  seq: number,
  properties: Record<string, unknown> = {},
): Item {
  return {
    id,
    workspaceId: 'workspace-1',
    parentId: 'folder-1',
    type: 'note',
    title,
    hasChildren: false,
    seq,
    lifecycleState: 'active',
    properties,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function property(key: string, label: string, type: string): PropertyDefinition {
  return { key, label, type, options: [], required: false };
}

const DONE = property('done', 'Done', 'checkbox');
const WHERE = property('aisle', 'Aisle', 'text');
const COMPLETE = property('completion', 'Complete', 'completion');

function schemaOf(...properties: PropertyDefinition[]): EffectiveSchema {
  return { properties, declared: properties, inherit: true };
}

const LINES = [
  item('milk', 'Milk', 1, { done: true, aisle: 'Dairy' }),
  item('bread', 'Bread', 2, { aisle: 'Bakery' }),
  item('eggs', 'Eggs', 3, { done: false }),
];

interface HarnessOptions {
  readonly view?: Partial<View>;
  readonly schema?: EffectiveSchema;
  readonly refuseWrite?: string;
  readonly refuseCreate?: string;
  readonly onCreate?: (title: string) => void;
}

/** A checklist over an in-memory container whose writes land optimistically, like `useContainer`. */
function Harness(options: HarnessOptions): ReactNode {
  const [children, setChildren] = useState<readonly Item[]>(LINES);
  const container = aContainer({
    schema: options.schema ?? schemaOf(DONE, WHERE),
    children,
    setProperties: async (itemId, properties) => {
      await Promise.resolve();
      if (options.refuseWrite !== undefined) return options.refuseWrite;
      setChildren((current) =>
        current.map((entry) =>
          entry.id === itemId
            ? { ...entry, properties: { ...entry.properties, ...properties } }
            : entry,
        ),
      );
      return null;
    },
    create: async (title) => {
      await Promise.resolve();
      options.onCreate?.(title);
      if (options.refuseCreate !== undefined) return options.refuseCreate;
      setChildren((current) => [...current, item(`new-${title}`, title, current.length + 1)]);
      return null;
    },
  });
  return (
    <ChecklistView
      container={container}
      view={aView({ kind: 'checklist', columns: ['aisle'], ...options.view })}
      onOpen={vi.fn()}
    />
  );
}

describe('ChecklistView', () => {
  it('draws one line per item with a box, the title and its one secondary property', () => {
    renderAt(<Harness />);

    expect(screen.getByRole('checkbox', { name: 'Milk' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Bread' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Open Milk' })).toBeInTheDocument();
    expect(screen.getByText('Dairy')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('1 of 3 done');
  });

  it('ticks a line by writing the done property, and counts it', async () => {
    const user = userEvent.setup();
    renderAt(<Harness />);

    await user.click(screen.getByRole('checkbox', { name: 'Bread' }));

    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: 'Bread' })).toBeChecked();
    });
    expect(screen.getByRole('status')).toHaveTextContent('2 of 3 done');
  });

  it('says so beside the line when a tick is refused', async () => {
    const user = userEvent.setup();
    renderAt(<Harness refuseWrite="This item is read-only." />);

    await user.click(screen.getByRole('checkbox', { name: 'Bread' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('This item is read-only.');
    expect(screen.getByRole('checkbox', { name: 'Bread' })).not.toBeChecked();
  });

  it('hides done lines on request and says the toggle is pressed', async () => {
    const user = userEvent.setup();
    renderAt(<Harness />);

    const toggle = screen.getByRole('button', { name: 'Hide done' });
    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('checkbox', { name: 'Milk' })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Bread' })).toBeInTheDocument();
  });

  it('adds lines from the field at the bottom and keeps focus there for the next one', async () => {
    const user = userEvent.setup();
    const created: string[] = [];
    renderAt(<Harness onCreate={(title) => created.push(title)} />);

    const field = screen.getByRole('textbox', { name: 'Add a line' });
    await user.click(field);
    await user.type(field, 'Butter{Enter}');
    await user.type(field, 'Jam{Enter}');

    expect(created).toEqual(['Butter', 'Jam']);
    expect(field).toHaveFocus();
    expect(field).toHaveValue('');
    expect(await screen.findByRole('checkbox', { name: 'Jam' })).toBeInTheDocument();
  });

  it('puts the name back and says why when a line cannot be added', async () => {
    const user = userEvent.setup();
    renderAt(<Harness refuseCreate="This item does not accept new children." />);

    const field = screen.getByRole('textbox', { name: 'Add a line' });
    await user.type(field, 'Butter{Enter}');

    expect(await screen.findByRole('alert')).toHaveTextContent('does not accept new children');
    expect(field).toHaveValue('Butter');
  });

  it('ticks a task completion when there is no done checkbox', () => {
    expect(resolveDoneProperty([WHERE, COMPLETE], null)).toEqual({
      kind: 'ready',
      property: COMPLETE,
    });
    expect(resolveDoneProperty([DONE, COMPLETE], null)).toEqual({ kind: 'ready', property: DONE });
    expect(resolveDoneProperty([DONE, COMPLETE], 'completion')).toEqual({
      kind: 'ready',
      property: COMPLETE,
    });
    expect(resolveDoneProperty([WHERE], 'aisle').kind).toBe('wrongType');
  });

  it('explains itself instead of drawing boxes when there is nothing to tick', () => {
    renderAt(<Harness schema={schemaOf(WHERE)} />);

    expect(screen.getByText('This checklist has nothing to tick')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});
