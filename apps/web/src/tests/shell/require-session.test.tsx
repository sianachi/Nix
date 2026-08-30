import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useSessionStore } from '../../auth/session-store';
import { stubCoreApi } from '../api-stub';
import { renderAt } from '../render-with-router';
import { App } from '../../app';

/**
 * The session gate, and the promise that it never lies about where sign-in has got to.
 *
 * Four states, four different things on screen. The one worth protecting hardest is the difference
 * between "we are still checking" and "you are signed out": showing the login screen during a
 * session restoration flashes it in front of someone whose session is about to come back, which reads as
 * being signed out and prompts a pointless click.
 */
describe('the session gate', () => {
  it('shows the sign-in screen when nobody is signed in', () => {
    useSessionStore.setState({ status: 'anonymous', profile: null, error: null });

    renderAt(<App />);

    expect(screen.getByRole('heading', { level: 1, name: /sign in/i })).toBeVisible();
    expect(screen.getByRole('button', { name: /continue with sso/i })).toBeEnabled();
    expect(screen.queryByRole('textbox', { name: /organisation/i })).not.toBeInTheDocument();
  });

  it('says it is restoring rather than showing sign-in while a renew is in flight', () => {
    useSessionStore.setState({ status: 'authenticating', profile: null, error: null });

    renderAt(<App />);

    expect(screen.getByText(/restoring session/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: /continue with sso/i })).not.toBeInTheDocument();
  });

  it('explains a server without interactive authentication rather than offering a broken sign-in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            authenticated: false,
            configured: false,
            profile: null,
            accessToken: null,
            expiresAt: null,
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    useSessionStore.setState({ status: 'unknown', profile: null, error: null });

    renderAt(<App />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/not configured on this nix server/i);
    expect(screen.getByRole('heading', { level: 1, name: /sign in/i })).toBeVisible();
  });

  it('surfaces why the last attempt failed instead of a bare sign-in screen', () => {
    useSessionStore.setState({
      status: 'failed',
      profile: null,
      error: 'Tokens from unregistered issuers are rejected.',
    });

    renderAt(<App />);

    expect(screen.getByRole('alert')).toHaveTextContent(/unregistered issuers/i);
  });

  it('never renders a password field, because Nix stores no passwords', () => {
    useSessionStore.setState({ status: 'anonymous', profile: null, error: null });

    const { container } = renderAt(<App />);

    // A sign-in screen that looks like it might want a password teaches people to type one
    // somewhere. There is no field, and this is the test that keeps it that way.
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });

  it('lets a signed-in person through to the application', async () => {
    useSessionStore.setState({
      status: 'authenticated',
      profile: { subject: 'sub-1', name: 'Ada Admin', email: 'ada@acme.test' },
      error: null,
    });

    stubCoreApi();
    renderAt(<App />);

    expect(screen.queryByRole('button', { name: /continue with sso/i })).not.toBeInTheDocument();
    expect(await screen.findByRole('banner')).toBeInTheDocument();
  });
});
