import { Text } from '@nix/ui';
import { useState, type ReactNode } from 'react';

import type { Item, PropertyDefinition, View } from '../views/core/container-model';
import { ContainerView } from '../views/core/container-view';
import { storyContainer, storyItem } from '../views/core/story-container';
import { VIEW_GUTTER } from '../views/core/view-gutter';
import { ViewSwitcher } from '../views/core/view-switcher';
import type { PlanWrite } from '../views/core/use-container';
import { RecordViewStory, recordStoryView } from '../views/list/record-view-story';

const PROPERTIES: PropertyDefinition[] = [
  {
    key: 'status',
    label: 'Status',
    type: 'select',
    options: ['To do', 'Doing', 'Done'],
    required: false,
  },
  {
    key: 'area',
    label: 'Area',
    type: 'select',
    options: ['Home', 'Work', 'Health'],
    required: false,
  },
  { key: 'starts', label: 'Starts', type: 'date', options: [], required: false },
  { key: 'due', label: 'Due', type: 'date', options: [], required: false },
  {
    key: 'urgency',
    label: 'Urgency',
    type: 'select',
    options: ['Urgent', 'Not urgent'],
    required: false,
  },
  {
    key: 'importance',
    label: 'Importance',
    type: 'select',
    options: ['Important', 'Not important'],
    required: false,
  },
  { key: 'done', label: 'Done', type: 'checkbox', options: [], required: false },
];

// The views the demo can draw from the children alone. Chart, outline, form and the rest read
// from Core, so they are left out rather than shown broken.
export const DEMO_VIEWS: readonly View[] = [
  recordStoryView('board', { name: 'Board', groupBy: 'status', columns: ['due', 'area'] }),
  recordStoryView('list', { name: 'List', columns: ['status', 'area', 'due'] }),
  recordStoryView('calendar', { name: 'Calendar', dateProperty: 'due' }),
  recordStoryView('timeline', { name: 'Timeline', dateProperty: 'starts', endDateProperty: 'due' }),
  recordStoryView('sheet', { name: 'Spreadsheet' }),
  recordStoryView('gallery', { name: 'Gallery', columns: ['area', 'status'] }),
  recordStoryView('checklist', { name: 'Checklist', columns: ['area'] }),
  recordStoryView('matrix', { name: 'Matrix', groupBy: 'urgency', rowBy: 'importance' }),
];

/** A date `offset` days from today, as the YYYY-MM-DD a date property stores. */
function day(offset: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function sampleItems(): Item[] {
  const rows: [string, Record<string, unknown>][] = [
    [
      'Plan the week',
      {
        status: 'Doing',
        area: 'Work',
        starts: day(0),
        due: day(0),
        urgency: 'Urgent',
        importance: 'Important',
      },
    ],
    [
      'Book a dentist appointment',
      {
        status: 'To do',
        area: 'Health',
        starts: day(1),
        due: day(3),
        urgency: 'Not urgent',
        importance: 'Important',
      },
    ],
    [
      'Fix the leaking tap',
      {
        status: 'To do',
        area: 'Home',
        starts: day(-1),
        due: day(2),
        urgency: 'Urgent',
        importance: 'Important',
      },
    ],
    [
      'Reply to the group chat',
      {
        status: 'Done',
        area: 'Home',
        starts: day(-2),
        due: day(-1),
        urgency: 'Urgent',
        importance: 'Not important',
        done: true,
      },
    ],
    [
      'Draft the quarterly review',
      {
        status: 'Doing',
        area: 'Work',
        starts: day(-3),
        due: day(5),
        urgency: 'Not urgent',
        importance: 'Important',
      },
    ],
    [
      'Run 5 km',
      {
        status: 'To do',
        area: 'Health',
        starts: day(2),
        due: day(2),
        urgency: 'Not urgent',
        importance: 'Important',
      },
    ],
    [
      'Sort old photos',
      {
        status: 'To do',
        area: 'Home',
        starts: day(4),
        due: day(9),
        urgency: 'Not urgent',
        importance: 'Not important',
      },
    ],
    [
      'Send the invoice',
      {
        status: 'Done',
        area: 'Work',
        starts: day(-4),
        due: day(-2),
        urgency: 'Urgent',
        importance: 'Important',
        done: true,
      },
    ],
  ];
  return rows.map(([title, properties], index) =>
    storyItem(`demo-${String(index + 1)}`, title, index + 1, properties),
  );
}

function patch(items: readonly Item[], itemId: string, values: Record<string, unknown>): Item[] {
  return items.map((item) =>
    item.id === itemId ? { ...item, properties: { ...item.properties, ...values } } : item,
  );
}

/**
 * The views over sample data held in this tab, for an install that turns the demo on
 * (`demo` in web-config.json). Mounted outside <App /> by main.tsx, so nothing here reaches Core:
 * every write lands in component state and a reload starts over.
 */
export function DemoPage(): ReactNode {
  const [children, setChildren] = useState(sampleItems);
  const [viewId, setViewId] = useState(DEMO_VIEWS[0]?.id ?? null);
  const view = DEMO_VIEWS.find((candidate) => candidate.id === viewId) ?? null;

  const container = storyContainer(children, PROPERTIES, {
    create: (title, properties = {}) => {
      const id = `demo-${crypto.randomUUID()}`;
      setChildren((current) => [...current, storyItem(id, title, current.length + 1, properties)]);
      return Promise.resolve(id);
    },
    setProperties: (itemId, values) => {
      setChildren((current) => patch(current, itemId, values));
      return Promise.resolve(null);
    },
    setPropertiesMany: (writes: readonly PlanWrite[]) => {
      setChildren((current) =>
        writes.reduce((items, write) => patch(items, write.itemId, write.properties), current),
      );
      return Promise.resolve({ saved: writes.length, refused: [] });
    },
  });

  return (
    <RecordViewStory>
      <div className="flex min-h-dvh flex-col bg-background font-body text-foreground">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-divider px-4 py-3 sm:px-8">
          <Text variant="note" as="p" tone="muted">
            Demo: sample data kept in this tab. Nothing is sent or saved; reload to start over.
          </Text>
          <a href="/" className="text-sm text-accent-text underline underline-offset-2">
            Back to Nix
          </a>
        </header>
        <main className="flex min-w-0 flex-1 flex-col gap-2 pt-6">
          <Text variant="h2" as="h1" className={VIEW_GUTTER}>
            This week
          </Text>
          <ViewSwitcher
            views={DEMO_VIEWS}
            unrenderable={[]}
            activeViewId={viewId}
            onSelect={setViewId}
          />
          <div className="min-w-0 flex-1 pb-8">
            <ContainerView container={container} view={view} onOpen={() => undefined} />
          </div>
        </main>
      </div>
    </RecordViewStory>
  );
}
