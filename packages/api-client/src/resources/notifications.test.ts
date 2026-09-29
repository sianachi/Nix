import { describe, expect, it } from 'vitest';

import {
  savePreferences,
  list,
  markRead,
  watch,
  addPushSubscription,
  removePushSubscription,
} from './notifications.js';

describe('the notifications resource', () => {
  it('savePreferences is a PUT that carries the expected revision and the input document', () => {
    const input = {
      timeZone: 'Europe/London',
      quietStart: '22:00',
      quietEnd: '07:00',
      dueReminderTime: '09:00',
      dueReminders: true,
      habitReminders: true,
      mutedContainerIds: [],
    };
    expect(savePreferences(3, input)).toMatchObject({
      kind: 'command',
      method: 'PUT',
      path: '/api/v1/me/preferences',
      body: { expectedRevision: 3, preferences: input },
    });
  });

  it('list is a GET that omits cursor and unreadOnly when not given', () => {
    const built = list();
    expect(built).toMatchObject({ kind: 'query', path: '/api/v1/me/notifications' });
    expect(built.query).not.toHaveProperty('cursor');
    expect(built.query).not.toHaveProperty('unreadOnly');
  });

  it('list carries cursor and unreadOnly as query parameters when given', () => {
    expect(list({ cursor: 'abc', unreadOnly: true })).toMatchObject({
      query: { cursor: 'abc', unreadOnly: true },
    });
  });

  it('markRead builds the per-notification path', () => {
    expect(markRead('n-1')).toMatchObject({
      kind: 'command',
      method: 'POST',
      path: '/api/v1/me/notifications/n-1/read',
    });
  });

  it('watch is a GET carrying after, and defaults it to 0', () => {
    expect(watch({ after: 42 })).toMatchObject({
      kind: 'query',
      operation: 'notifications.watch',
      path: '/api/v1/me/notifications/watch',
      query: { after: 42 },
    });
    expect(watch()).toMatchObject({ query: { after: 0 } });
  });

  it('addPushSubscription is a POST carrying endpoint, p256dh and auth', () => {
    expect(
      addPushSubscription('https://fcm.googleapis.com/fcm/send/x', 'key', 'auth'),
    ).toMatchObject({
      kind: 'command',
      method: 'POST',
      path: '/api/v1/me/push-subscriptions',
      body: { endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: 'key', auth: 'auth' },
    });
  });

  it('removePushSubscription is a DELETE carrying the endpoint to remove', () => {
    expect(removePushSubscription('https://fcm.googleapis.com/fcm/send/x')).toMatchObject({
      kind: 'command',
      method: 'DELETE',
      path: '/api/v1/me/push-subscriptions',
      body: { endpoint: 'https://fcm.googleapis.com/fcm/send/x' },
    });
  });
});
