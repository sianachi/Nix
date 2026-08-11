// Vite + Vitest configuration for @nix/web.
//
// Tailwind CSS v4 is CSS-first: there is no tailwind.config.js and no
// PostCSS chain. The @tailwindcss/vite plugin compiles src/app.css, which
// imports Tailwind and then the @nix/design-tokens @theme sheet, so every
// Industry token becomes a utility class.
//
// Content detection is automatic for this app's own source, but not sufficient
// on its own - see the @source directive in src/app.css, which says why.
//
// The test block runs the same source through jsdom. CSS is not processed
// during tests - component tests assert behaviour and roles, never computed
// styles, so compiling Tailwind for them would only cost time.
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * The token index.html carries where the identity provider's origin belongs in the policy.
 *
 * Deliberately not Vite's own `%VITE_OIDC_ISSUER%` HTML substitution: that leaves the literal
 * `%VITE_OIDC_ISSUER%` in the output when the variable is unset, which lands an invalid source
 * expression in a security header, and it substitutes the whole issuer URL where CSP accepts only
 * an origin. This plugin narrows the value to its origin and removes the token entirely when there
 * is nothing to put there.
 */
export const OIDC_ORIGIN_TOKEN = '__NIX_OIDC_ORIGIN__';

/**
 * The origin a CSP source expression can name, from a full issuer URL.
 *
 * `connect-src`/`frame-src` match on origin, so an issuer carrying a path (Zitadel instances often
 * do) must be reduced to scheme, host and port. An unset or unparseable issuer yields an empty
 * string, and the caller then drops the token rather than emitting a source expression the browser
 * would ignore.
 */
export function oidcOriginFor(issuer: string | undefined): string {
  if (typeof issuer !== 'string' || issuer.length === 0) {
    return '';
  }

  try {
    return new URL(issuer).origin;
  } catch {
    return '';
  }
}

/** Substitutes {@link OIDC_ORIGIN_TOKEN} in index.html with the configured issuer's origin. */
export function oidcOriginInPolicy(): Plugin {
  let issuer: string | undefined;

  return {
    name: 'nix:oidc-origin-in-policy',
    configResolved(resolved) {
      issuer = resolved.env.VITE_OIDC_ISSUER as string | undefined;
    },
    transformIndexHtml: {
      // Before Vite's own HTML handling, so the document the rest of the pipeline sees already
      // carries the final policy.
      order: 'pre',
      handler(html) {
        return substituteOidcOrigin(html, issuer);
      },
    },
  };
}

/** The substitution itself, separated so a test can exercise it without running a build. */
export function substituteOidcOrigin(html: string, issuer: string | undefined): string {
  const origin = oidcOriginFor(issuer);

  // The leading space is part of the match: with no issuer the directive collapses back to exactly
  // `connect-src 'self'` rather than keeping a dangling separator.
  return html.replaceAll(` ${OIDC_ORIGIN_TOKEN}`, origin.length > 0 ? ` ${origin}` : '');
}

export default defineConfig({
  server: {
    // The API is a different origin in development. Proxying keeps the browser same-origin, so
    // there is no CORS preflight on every request and no cookie/credential surprises - the token
    // travels in the Authorization header either way, but same-origin is the shape production has.
    proxy: {
      '/api': {
        target: 'http://localhost:5014',
        changeOrigin: true,
      },

      // The collaboration service is a third origin, and it holds the document bodies. The
      // prefix is stripped because the service's own routes are '/documents/...' - it does not
      // know or care that the browser reaches it under a path.
      '/collab': {
        target: 'http://localhost:8100',
        changeOrigin: true,
        // The editor reaches the service over a WebSocket; without this the proxy
        // answers the upgrade itself and the socket never opens.
        ws: true,
        rewrite: (path: string) => path.replace(/^\/collab/, ''),
      },
    },
  },

  plugins: [react(), tailwindcss(), oidcOriginInPolicy()],
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/tests/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,

    // Not the 5000 default, and please do not "tidy" it back.
    //
    // Reproduce before changing this: `pnpm --filter @nix/web test
    // --reporter=json`, full 47-file suite in parallel, otherwise-idle 10-core
    // machine. The numbers below are from exactly that.
    //
    // The worst case used to be 'counts February 2028 as a leap February' in
    // src/tests/views/calendar/calendar-view.test.tsx. Worst figure on record for it: 4849ms,
    // 97% of the 5000 default, idle. Re-measured on the same machine it came
    // back at 4041ms, 81% - and that spread between two idle runs of the same
    // test is itself the argument, because a CI runner is never the better of
    // the two. It was not irreducible render cost: the test reached
    // February 2028 by clicking "Next month" 23 times, so 23 sequential
    // userEvent round trips paid for navigation that was scaffolding rather
    // than the behaviour under test. Those loops are gone - the two tests that
    // had them now name their month on the fake clock the suite already runs,
    // and the second-worst offender kept its single boundary-crossing click
    // because that click is the claim.
    //
    // Those two tests now cost 122ms and 210ms. What remains at the top is
    // ordinary per-test page render into jsdom under parallel contention,
    // peaking at 1545ms ('says which week it is showing, naming both months
    // when it straddles them' in calendar-modes.test.tsx, which keeps its two
    // clicks because a straddling week cannot be reached in one). Idle that is
    // 31% of the default - but idle is not what CI gives you, and the figures
    // above show the same test swinging by ~20% between two idle runs. 15s
    // keeps headroom for that without letting a genuinely hung test sit for a
    // minute. The failure it prevents is the expensive kind: a timeout on a
    // busy runner is indistinguishable from a real regression until someone
    // reruns it alone.
    //
    // Node-environment packages do not need this, and packages/ui's component
    // tests peak at 703ms idle, so the value stays here rather than spreading
    // across the workspace.
    testTimeout: 15_000,
  },
});
