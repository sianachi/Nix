import type { ReactNode } from 'react';
import { useState } from 'react';
import { within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';

import type { PropertyDefinition } from '../core/container-model';
import { storyContainer, storyItem } from '../core/story-container';
import { RecordViewStory, recordStoryView } from '../list/record-view-story';
import { BoardView } from './board-view';

export default { title: 'Nix/Views/Board', parameters: { layout: 'padded' } };
const STATUS: PropertyDefinition = {
  key: 'status',
  label: 'Status',
  type: 'select',
  options: ['To do', 'Doing', 'Done'],
  required: false,
};
const START = [
  storyItem('a', 'Plan the week', 1, { status: 'To do' }),
  storyItem('b', 'Write a poem about the first signs of autumn', 2, { status: 'Doing' }),
  storyItem('c', 'Choose our next trip together', 3, { status: 'Done' }),
];

function Example(): ReactNode {
  const [children, setChildren] = useState(START);
  const container = storyContainer(children, [STATUS], {
    setProperties: (id, values) => {
      setChildren((current) =>
        current.map((item) =>
          item.id === id ? { ...item, properties: { ...item.properties, ...values } } : item,
        ),
      );
      return Promise.resolve(null);
    },
  });
  return (
    <RecordViewStory>
      <BoardView
        container={container}
        view={recordStoryView('board', { groupBy: 'status' })}
        onOpen={() => undefined}
      />
    </RecordViewStory>
  );
}

export const Plans = { render: (): ReactNode => <Example /> };
export const NarrowPlans = {
  render: (): ReactNode => (
    <div className="max-w-xs">
      <Example />
    </div>
  ),
};
export const RowActions = {
  ...Plans,
  play: async ({ canvasElement }: { readonly canvasElement: HTMLElement }): Promise<void> => {
    const target = within(canvasElement).getByRole('button', { name: 'Plan the week' });
    target.focus();
    await userEvent.keyboard('{Shift>}{F10}{/Shift}');
  },
};
export const DarkPlans = { ...Plans, globals: { ground: 'dark' } };
export const DarkNarrowPlans = { ...NarrowPlans, globals: { ground: 'dark' } };
export const DarkRowActions = { ...RowActions, globals: { ground: 'dark' } };
