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
import { defineConfig } from 'vitest/config';

const fallbackCspMeta =
  /\s*<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]+"\s+data-nix-csp-fallback\s*\/>/u;

export function parseObjectStorePublicOrigin(value: string): string {
  if (value === '' || value !== value.trim() || value.length > 2_048) {
    throw new Error('NIX_OBJECT_STORE_PUBLIC_ORIGIN must be one bounded HTTP(S) origin.');
  }

  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error('NIX_OBJECT_STORE_PUBLIC_ORIGIN must be an absolute HTTP(S) origin.');
  }

  const loopback =
    origin.hostname === 'localhost' ||
    origin.hostname === '127.0.0.1' ||
    origin.hostname === '[::1]';
  if (
    (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback)) ||
    origin.username !== '' ||
    origin.password !== '' ||
    origin.pathname !== '/' ||
    origin.search !== '' ||
    origin.hash !== ''
  ) {
    throw new Error(
      'NIX_OBJECT_STORE_PUBLIC_ORIGIN must be HTTPS outside loopback development and must not contain credentials, a path, query, or fragment.',
    );
  }

  return origin.origin;
}

export function contentSecurityPolicy(objectStorePublicOrigin: string): string {
  const origin = parseObjectStorePublicOrigin(objectStorePublicOrigin);
  return `default-src 'self'; script-src 'self' 'sha256-qzYt63qWJpMm2Kfb4Wr8UDbUtUgweR4Gv4rs133db2w='; style-src 'self' 'unsafe-inline'; img-src 'self' http: https: data:; font-src 'self'; connect-src 'self' ${origin}; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'`;
}

const objectStorePublicOrigin = parseObjectStorePublicOrigin(
  process.env.NIX_OBJECT_STORE_PUBLIC_ORIGIN ?? 'http://localhost:7070',
);
const browserPolicy = contentSecurityPolicy(objectStorePublicOrigin);

export default defineConfig({
  server: {
    headers: { 'Content-Security-Policy': browserPolicy },
    // The API is a different origin in development. Proxying keeps the browser same-origin, so
    // there is no CORS preflight on every request and no cookie/credential surprises - the token
    // travels in the Authorization header either way, but same-origin is the shape production has.
    proxy: {
      '/api': {
        target: 'http://localhost:5014',
        changeOrigin: true,
      },
      '/auth': {
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

  preview: {
    headers: { 'Content-Security-Policy': browserPolicy },
  },

  plugins: [
    {
      name: 'nix-configured-content-security-policy',
      enforce: 'pre',
      transformIndexHtml(html) {
        const transformed = html.replace(fallbackCspMeta, '');
        if (transformed === html) {
          throw new Error('The marked fallback Content-Security-Policy meta tag is missing.');
        }
        return transformed;
      },
    },
    react(),
    tailwindcss(),
  ],
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
