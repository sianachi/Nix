import type { NotificationDto } from '@nix/api-client';
import type { ReactElement } from 'react';

import { NotificationInboxPanel } from './notification-inbox-panel';
import type { NotificationsInboxState } from './use-notifications-inbox';

export default { title: 'Nix/Notification inbox', parameters: { layout: 'fullscreen' } };

const noop = (): void => undefined;

function baseState(overrides: Partial<NotificationsInboxState> = {}): NotificationsInboxState {
  return {
    items: [],
    unread: 0,
    loading: false,
    error: null,
    hasMore: false,
    loadingMore: false,
    loadMore: noop,
    markRead: noop,
    markAllRead: noop,
    reload: noop,
    onArrived: () => noop,
    ...overrides,
  };
}

const sampleNotifications: readonly NotificationDto[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'reminder',
    title: 'Renew the domain',
    body: 'Due today at 5:00 PM.',
    itemId: '22222222-2222-4222-8222-222222222222',
    workspaceId: '33333333-3333-4333-8333-333333333333',
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    readAt: null,
  },
  {
    id: '44444444-4444-4444-8444-444444444444',
    kind: 'automation',
    title: 'Weekly review created',
    body: '',
    itemId: null,
    workspaceId: null,
    createdAt: new Date(Date.now() - 26 * 60 * 60_000).toISOString(),
    readAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString(),
  },
];

/** The honest empty state - nothing owed here yet, not an error. */
export const Empty = {
  render: (): ReactElement => (
    <NotificationInboxPanel open onClose={noop} inbox={baseState()} onOpenItem={noop} />
  ),
};

export const Loading = {
  render: (): ReactElement => (
    <NotificationInboxPanel
      open
      onClose={noop}
      inbox={baseState({ loading: true })}
      onOpenItem={noop}
    />
  ),
};

export const LoadFailed = {
  render: (): ReactElement => (
    <NotificationInboxPanel
      open
      onClose={noop}
      inbox={baseState({
        error: 'The inbox could not be loaded. Check your connection and try again.',
      })}
      onOpenItem={noop}
    />
  ),
};

/** A mix of unread and read notifications, one with a linked item and one without. */
export const WithNotifications = {
  render: (): ReactElement => (
    <NotificationInboxPanel
      open
      onClose={noop}
      inbox={baseState({ items: sampleNotifications, unread: 1 })}
      onOpenItem={noop}
    />
  ),
};

export const LoadingMore = {
  render: (): ReactElement => (
    <NotificationInboxPanel
      open
      onClose={noop}
      inbox={baseState({
        items: sampleNotifications,
        unread: 1,
        hasMore: true,
        loadingMore: true,
      })}
      onOpenItem={noop}
    />
  ),
};

export const DarkWithNotifications = { ...WithNotifications, globals: { ground: 'dark' } };
