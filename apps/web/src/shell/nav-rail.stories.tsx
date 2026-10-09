import type { Workspace } from '@nix/api-client';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';

import { useKnownSmartListsStore } from '../views/query/known-smart-lists';
import { WorkspaceProvider } from '../workspaces/workspace-context';
import { NavRail } from './nav-rail';

export default { title: 'Nix/Shell/Navigation rail', parameters: { layout: 'fullscreen' } };

const WORKSPACE = 'd5555555-5555-4555-8555-555555555555';
const noop = (): void => undefined;

const workspace: Workspace = {
  id: WORKSPACE,
  name: 'Personal',
  versionRetentionDays: 90,
  storageQuotaBytes: 0,
  createdAt: '2026-01-01T00:00:00Z',
  kind: 'personal',
  canRename: true,
  canManageMembers: false,
  canLeave: false,
  canUseDailyNotes: true,
  pendingInvitationId: null,
  lifecycleState: 'active',
  archivedAt: null,
};

/**
 * The rail with its Queries section: one pinned smart list beside the Queries control, and the
 * menu (open it from the Queries glyph) listing every smart list this browser has opened.
 */
function Example({ compact = false }: { readonly compact?: boolean }): ReactNode {
  useKnownSmartListsStore.setState({
    known: {
      [WORKSPACE]: [
        { id: 'shopping', title: 'Shopping', pinned: true },
        { id: 'overdue', title: 'Overdue', pinned: false },
      ],
    },
  });
  return (
    <MemoryRouter initialEntries={[`/w/${WORKSPACE}`]}>
      <Routes>
        <Route
          path="/w/:workspaceId"
          element={
            <WorkspaceProvider
              state={{
                status: 'ready',
                workspaces: [workspace],
                error: null,
                reload: noop,
                workspaceCreated: noop,
                workspaceUpdated: noop,
                workspaceRemoved: noop,
              }}
            >
              <div className="flex h-dvh">
                <NavRail onImport={noop} compact={compact} />
              </div>
            </WorkspaceProvider>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

export const WithQueries = { render: (): ReactNode => <Example /> };
export const CompactWithQueries = { render: (): ReactNode => <Example compact /> };
export const DarkWithQueries = { ...WithQueries, globals: { ground: 'dark' } };
export const DarkCompactWithQueries = { ...CompactWithQueries, globals: { ground: 'dark' } };
