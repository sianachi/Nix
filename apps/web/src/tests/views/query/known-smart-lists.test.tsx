import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ContainerViews } from '../../../views/core/container-model';
import {
  useKnownSmartLists,
  useKnownSmartListsStore,
  useRememberSmartList,
} from '../../../views/query/known-smart-lists';
import { aView } from '../../view-fixture';

const WORKSPACE = 'workspace-1';

function viewsOpeningOn(kind: string): ContainerViews {
  const view = aView({ id: 'v1', kind });
  return { views: [view], unrenderable: [], default: 'v1', hideDocument: false };
}

beforeEach(() => {
  useKnownSmartListsStore.setState({ known: {} });
});

describe('the smart lists this browser knows', () => {
  it('remembers an item whose default view is a query, under its title', () => {
    renderHook(() => {
      useRememberSmartList(WORKSPACE, 'item-1', 'Overdue', viewsOpeningOn('query'));
    });

    expect(useKnownSmartListsStore.getState().known[WORKSPACE]).toEqual([
      { id: 'item-1', title: 'Overdue', pinned: false },
    ]);
  });

  it('forgets one whose default view is no longer a query, and ignores views still loading', () => {
    useKnownSmartListsStore.getState().remember(WORKSPACE, 'item-1', 'Overdue');

    renderHook(() => {
      useRememberSmartList(WORKSPACE, 'item-2', 'Loading', null);
      useRememberSmartList(WORKSPACE, 'item-1', 'Overdue', viewsOpeningOn('list'));
    });

    expect(useKnownSmartListsStore.getState().known[WORKSPACE]).toEqual([]);
  });

  it('lists pinned ones first and keeps each workspace apart', () => {
    const store = useKnownSmartListsStore.getState();
    store.remember(WORKSPACE, 'a', 'Alpha');
    store.remember(WORKSPACE, 'b', 'Bravo');
    store.remember('other', 'c', 'Charlie');
    useKnownSmartListsStore.getState().setPinned(WORKSPACE, 'a', true);

    const { result } = renderHook(() => useKnownSmartLists(WORKSPACE));

    expect(result.current.map((entry) => entry.id)).toEqual(['a', 'b']);
  });
});
