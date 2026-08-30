import { browserStorage } from '../lib/browser-storage';

/**
 * A non-secret hint that this browser has completed sign-in before.
 *
 * Tokens remain in oidc-client-ts's tab-scoped sessionStorage user store. This localStorage entry
 * stores only the answer to "is a silent restore worth trying?", so a first visit and an explicitly
 * signed-out browser do not spend several seconds waiting for an identity-provider iframe that
 * cannot restore anything.
 */
const SESSION_HINT_KEY = 'nix.session-established';

export function hasSessionHint(): boolean {
  try {
    return browserStorage()?.getItem(SESSION_HINT_KEY) === '1';
  } catch {
    return false;
  }
}

export function rememberSession(): void {
  try {
    browserStorage()?.setItem(SESSION_HINT_KEY, '1');
  } catch {
    // Storage is an optimisation, not a requirement. Sign-in still works without it.
  }
}

export function forgetSession(): void {
  try {
    browserStorage()?.removeItem(SESSION_HINT_KEY);
  } catch {
    // A browser refusing storage has already forgotten the hint for us.
  }
}
