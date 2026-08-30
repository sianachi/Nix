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
 * silent renew flashes it in front of someone whose session is about to come back, which reads as
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

  it('explains a missing identity provider rather than offering a sign-in that cannot work', () => {
    // Stated rather than inherited. The provider reads `import.meta.env`, and a developer who has
    // run zitadel-configure.sh has a .env.local that configures it - so without this the test
    // asserts unconfigured behaviour on a configured build and fails on their machine and nobody
    // else's. `vi.unstubAllEnvs` in the global setup puts it back.
    vi.stubEnv('VITE_OIDC_ISSUER', '');
    vi.stubEnv('VITE_OIDC_CLIENT_ID', '');

    // From `unknown`, with no issuer configured, the provider resolves immediately to signed-out
    // and the screen says why. The failure this replaces would be a login button that redirects
    // nowhere, or a shell that spins forever - both worse than being told the build is not
    // configured.
    useSessionStore.setState({ status: 'unknown', profile: null, error: null });

    renderAt(<App />);

    expect(screen.getByRole('alert')).toHaveTextContent(/no identity provider is configured/i);
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
