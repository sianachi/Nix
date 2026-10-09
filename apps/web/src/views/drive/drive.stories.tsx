import type { ReactNode } from 'react';
import { within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';

import { storyContainer, storyItem } from '../core/story-container';
import { RecordViewStory, recordStoryView, STORY_FILE } from '../list/record-view-story';
import { DriveView } from './drive-view';

export default { title: 'Nix/Views/Drive', parameters: { layout: 'padded' } };
function Example({ layout = 'list' }: { readonly layout?: string }): ReactNode {
  return (
    <RecordViewStory>
      <DriveView
        container={storyContainer(
          [
            storyItem('a', 'Ideas for a quiet weekend', 1),
            storyItem('b', 'Canvas for the garden plan', 2, {}, 'canvas'),
            storyItem(STORY_FILE, 'Reading list.txt', 3, {}, 'file'),
          ],
          [],
          { itemId: null },
        )}
        view={recordStoryView('drive', { layout })}
        onOpen={() => undefined}
      />
    </RecordViewStory>
  );
}
export const Files = { render: (): ReactNode => <Example /> };
export const Grid = { render: (): ReactNode => <Example layout="grid" /> };
export const NarrowFiles = {
  render: (): ReactNode => (
    <div className="max-w-xs">
      <Example />
    </div>
  ),
};
export const MoveDialog = {
  ...Files,
  play: async ({ canvasElement }: { readonly canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Select Reading list.txt' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Move to…' }));
  },
};
export const RowActions = {
  ...Grid,
  play: async ({ canvasElement }: { readonly canvasElement: HTMLElement }): Promise<void> => {
    within(canvasElement).getByRole('button', { name: 'Reading list.txt' }).focus();
    await userEvent.keyboard('{Shift>}{F10}{/Shift}');
  },
};
export const DarkFiles = { ...Files, globals: { ground: 'dark' } };
export const DarkGrid = { ...Grid, globals: { ground: 'dark' } };
export const DarkNarrowFiles = { ...NarrowFiles, globals: { ground: 'dark' } };
export const DarkMoveDialog = { ...MoveDialog, globals: { ground: 'dark' } };
export const DarkRowActions = { ...RowActions, globals: { ground: 'dark' } };
