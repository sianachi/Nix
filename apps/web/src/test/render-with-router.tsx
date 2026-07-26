import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';

import { useSessionStore } from '../auth/session-store';

/**
 * Renders a tree under a MemoryRouter at a given URL.
 *
 * Tests drive the app the way a user does - through the address - so the URL-state convention is
 * exercised rather than mocked.
 */
export function renderAt(ui: ReactElement, url = '/'): RenderResult {
  return render(<MemoryRouter initialEntries={[url]}>{ui}</MemoryRouter>);
}

/**
 * A signed-in session, for tests about what the application does once someone is past the gate.
 *
 * The store is seeded directly rather than by driving a real sign-in: an OIDC redirect cannot
 * happen in jsdom, and a test about the workspace switcher should not depend on an identity
 * provider being reachable. Tests that are *about* signing in drive the gate itself instead.
 *
 * Call before rendering. `resetSession` runs from the global test setup, so no test inherits
 * another's session.
 */
export function signedIn(): void {
  useSessionStore.setState({
    status: 'authenticated',
    profile: { subject: 'test-subject', name: 'Test Person', email: 'test@example.test' },
    error: null,
  });
}

/** Returns the session store to its initial, nobody-signed-in state. */
export function resetSession(): void {
  useSessionStore.setState({ status: 'anonymous', profile: null, error: null });
}
