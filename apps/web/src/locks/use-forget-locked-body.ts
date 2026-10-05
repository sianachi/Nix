import { useEffect } from 'react';

import { useSessionStore } from '../auth/session-store';
import { sealItemBodies } from '../editor/body-cache';
import { useOptionalWorkspace } from '../workspaces/workspace-context';
import type { ItemLockView } from './use-item-lock';

/**
 * A locked body is never kept on this device (ADR-0053). Editors already decline to cache one;
 * this removes a copy taken before the lock existed - by this person, or before someone else
 * locked it - the moment the page learns of the lock, whether or not the body is unlocked now.
 */
export function useForgetLockedBody(
  itemId: string,
  lock: Pick<ItemLockView, 'status' | 'locked'>,
): void {
  const subject = useSessionStore((state) => state.profile?.subject);
  const workspaceId = useOptionalWorkspace()?.workspaceId;
  const locked = lock.status === 'ready' && lock.locked;

  useEffect(() => {
    if (!locked || subject === undefined || workspaceId === undefined) return;
    if (typeof indexedDB === 'undefined') return;
    void sealItemBodies(subject, workspaceId, itemId).catch(() => undefined);
  }, [itemId, locked, subject, workspaceId]);
}
