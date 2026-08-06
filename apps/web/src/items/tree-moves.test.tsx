import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { WorkspaceSidebar } from './workspace-sidebar';
import type { TreeItem, WorkspaceTree } from './use-workspace-tree';

/**
 * Moving an item without a pointer.
 *
 * A drop zone that exists only for a mouse is not a move affordance, it is a move affordance for
 * some people. The three landings a drag can produce - before, after, inside - each need a keyboard
 * equivalent, and these are the outliner bindings anybody who has used a list of nested things
 * already has in their fingers.
 *
 * Asserted on the move that is requested rather than on the tree that results, because the tree's
 * new shape is the server's answer and this is about the gesture reaching it correctly.
 */

const ROOT_A: TreeItem = {
  id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  title: 'First',
  type: 'note',
  parentId: null,
  hasChildren: false,
  seq: 1000,
  lifecycleState: 'active',
};

const ROOT_B: TreeItem = {
  ...ROOT_A,
  id: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
  title: 'Second',
  seq: 2000,
};
const ROOT_C: TreeItem = {
  ...ROOT_A,
  id: 'cccccccc-1111-4111-8111-cccccccccccc',
  title: 'Third',
  seq: 3000,
};

function treeOf(move: WorkspaceTree['move']): WorkspaceTree {
  const items = [ROOT_A, ROOT_B, ROOT_C];

  return {
    status: 'ready',
    error: null,
    items,
    isCreating: false,
    find: (id: string) => items.find((item) => item.id === id) ?? null,
    childrenOf: (parentId: string | null) => items.filter((item) => item.parentId === parentId),
    breadcrumbs: () => [],
    isExpanded: () => false,
    isLoadingChildren: () => false,
    toggle: () => Promise.resolve(),
    reveal: () => Promise.resolve(),
    create: () => Promise.resolve(null),
    rename: () => Promise.resolve(),
    move,
    remove: () => Promise.resolve(),
    restore: () => Promise.resolve(),
    reload: () => Promise.resolve(),
  } as unknown as WorkspaceTree;
}

function focusRow(title: string): void {
  screen.getByRole('button', { name: title }).focus();
}

describe('moving an item from the keyboard', () => {
  it('moves it above the sibling before it', async () => {
    const user = userEvent.setup();
    const move = vi.fn(() => Promise.resolve());
    render(
      <WorkspaceSidebar
        tree={treeOf(move)}
        selectedId={null}
        onSelect={vi.fn()}
        onOpenBeside={() => undefined}
        onOpenPinned={() => undefined}
        besideRefusal={null}
        canOpenBeside
        onDeleteItem={vi.fn()}
        treeRegionRef={{ current: null }}
      />,
    );

    focusRow('Second');
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');

    // Before "First" means after nothing, since "First" is the first of its siblings.
    await waitFor(() => {
      expect(move).toHaveBeenCalledWith(ROOT_B.id, null, null);
    });
  });

  it('moves it below the sibling after it', async () => {
    const user = userEvent.setup();
    const move = vi.fn(() => Promise.resolve());
    render(
      <WorkspaceSidebar
        tree={treeOf(move)}
        selectedId={null}
        onSelect={vi.fn()}
        onOpenBeside={() => undefined}
        onOpenPinned={() => undefined}
        besideRefusal={null}
        canOpenBeside
        onDeleteItem={vi.fn()}
        treeRegionRef={{ current: null }}
      />,
    );

    focusRow('First');
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');

    await waitFor(() => {
      expect(move).toHaveBeenCalledWith(ROOT_A.id, null, ROOT_B.id);
    });
  });

  it('puts it inside the sibling above when indented', async () => {
    const user = userEvent.setup();
    const move = vi.fn(() => Promise.resolve());
    render(
      <WorkspaceSidebar
        tree={treeOf(move)}
        selectedId={null}
        onSelect={vi.fn()}
        onOpenBeside={() => undefined}
        onOpenPinned={() => undefined}
        besideRefusal={null}
        canOpenBeside
        onDeleteItem={vi.fn()}
        treeRegionRef={{ current: null }}
      />,
    );

    focusRow('Second');
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');

    // The sibling above is the only unambiguous target: the one below cannot take it without
    // reordering them both.
    await waitFor(() => {
      expect(move).toHaveBeenCalledWith(ROOT_B.id, ROOT_A.id, null);
    });
  });

  it('does not indent the first of its siblings, which has nothing to go inside', async () => {
    const user = userEvent.setup();
    const move = vi.fn(() => Promise.resolve());
    render(
      <WorkspaceSidebar
        tree={treeOf(move)}
        selectedId={null}
        onSelect={vi.fn()}
        onOpenBeside={() => undefined}
        onOpenPinned={() => undefined}
        besideRefusal={null}
        canOpenBeside
        onDeleteItem={vi.fn()}
        treeRegionRef={{ current: null }}
      />,
    );

    focusRow('First');
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');

    expect(move).not.toHaveBeenCalled();
  });

  it('does not move the last of its siblings further down', async () => {
    const user = userEvent.setup();
    const move = vi.fn(() => Promise.resolve());
    render(
      <WorkspaceSidebar
        tree={treeOf(move)}
        selectedId={null}
        onSelect={vi.fn()}
        onOpenBeside={() => undefined}
        onOpenPinned={() => undefined}
        besideRefusal={null}
        canOpenBeside
        onDeleteItem={vi.fn()}
        treeRegionRef={{ current: null }}
      />,
    );

    focusRow('Third');
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');

    expect(move).not.toHaveBeenCalled();
  });

  it('leaves an unmodified arrow key alone', async () => {
    const user = userEvent.setup();
    const move = vi.fn(() => Promise.resolve());
    render(
      <WorkspaceSidebar
        tree={treeOf(move)}
        selectedId={null}
        onSelect={vi.fn()}
        onOpenBeside={() => undefined}
        onOpenPinned={() => undefined}
        besideRefusal={null}
        canOpenBeside
        onDeleteItem={vi.fn()}
        treeRegionRef={{ current: null }}
      />,
    );

    focusRow('Second');
    await user.keyboard('{ArrowUp}');

    // Arrow keys alone belong to whatever the browser and the tree do with focus. Claiming them
    // would break moving around the tree in order to serve the rarer act of rearranging it.
    expect(move).not.toHaveBeenCalled();
  });
});
