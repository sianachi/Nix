import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { stubCoreApi, type StubMember } from '../api-stub';
import { renderAt, signedIn } from '../render-with-router';
import { App } from '../../app';

/**
 * The members half of the settings screen: who holds a role here, and the honest states around
 * that answer. Loading is not empty, and a failed read is not a workspace with nobody in it.
 */

beforeEach(() => {
  signedIn();
});

const members: readonly StubMember[] = [
  {
    subjectType: 'principal',
    subjectId: '44444444-bbbb-4bbb-8bbb-444444444444',
    subjectDisplayName: 'Ada Lovelace',
    role: 'owner',
    grantedAt: '2026-01-05T09:00:00+00:00',
  },
  {
    subjectType: 'principal',
    subjectId: '55555555-bbbb-4bbb-8bbb-555555555555',
    subjectDisplayName: 'Grace Hopper',
    role: 'editor',
    grantedAt: '2026-03-12T09:00:00+00:00',
  },
  {
    subjectType: 'group',
    subjectId: '66666666-bbbb-4bbb-8bbb-666666666666',
    subjectDisplayName: 'Research',
    role: 'viewer',
    grantedAt: '2026-04-01T09:00:00+00:00',
  },
];

describe('the members section', () => {
  it('lists every member with a display name and a role', async () => {
    stubCoreApi({ members });
    renderAt(<App />, '/settings');

    const table = await screen.findByRole('table', {
      name: /principals and groups holding a role/i,
    });

    expect(within(table).getByText('Ada Lovelace')).toBeInTheDocument();
    expect(within(table).getByText('owner')).toBeInTheDocument();
    expect(within(table).getByText('Grace Hopper')).toBeInTheDocument();
    expect(within(table).getByText('editor')).toBeInTheDocument();
    expect(within(table).getByText('Research')).toBeInTheDocument();
    expect(within(table).getByText('viewer')).toBeInTheDocument();
  });

  it('marks a group grant apart from a personal one', async () => {
    stubCoreApi({ members });
    renderAt(<App />, '/settings');

    await screen.findByText('Research');
    expect(screen.getByText('Group')).toBeInTheDocument();
  });

  it('says it is loading before the answer arrives, rather than looking empty', () => {
    stubCoreApi({ members });
    renderAt(<App />, '/settings');

    // Synchronous on purpose: the read has not resolved yet, and this is the moment under test.
    expect(screen.getByText(/loading the workspace members/i)).toBeInTheDocument();
    expect(screen.queryByText(/nobody holds a role/i)).not.toBeInTheDocument();
  });

  it('renders a failed read as an error with a retry, not as an empty workspace', async () => {
    stubCoreApi({ membersFail: true });
    renderAt(<App />, '/settings');

    expect(await screen.findByRole('heading', { name: /the members could not be loaded/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText(/nobody holds a role/i)).not.toBeInTheDocument();
  });

  it('says a memberless answer out loud instead of leaving a blank table', async () => {
    stubCoreApi({ members: [] });
    renderAt(<App />, '/settings');

    expect(await screen.findByText(/nobody holds a role in this workspace yet/i)).toBeVisible();
  });
});
