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
import { createHash } from 'node:crypto';
import { cp, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const excalidrawFontUrlPrefix = '/excalidraw-assets/fonts/';
const requireFromViteConfig = createRequire(import.meta.url);
const excalidrawFontSourceDirectory = fileURLToPath(
  new URL('./node_modules/@excalidraw/excalidraw/dist/prod/fonts/', import.meta.url),
);
const roughjsEntry = requireFromViteConfig.resolve('roughjs/bin/rough.js', {
  paths: [fileURLToPath(new URL('./node_modules/@excalidraw/excalidraw/', import.meta.url))],
});

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function excalidrawFontAssets(): Plugin {
  let buildOutputDirectory: string | undefined;

  return {
    name: 'nix:excalidraw-font-assets',
    configResolved(config) {
      buildOutputDirectory = resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const requestUrl = request.url;
        if (requestUrl === undefined) {
          next();
          return;
        }

        let pathname: string;
        try {
          pathname = new URL(requestUrl, 'http://nix.local').pathname;
        } catch {
          response.statusCode = 400;
          response.end();
          return;
        }

        if (!pathname.startsWith(excalidrawFontUrlPrefix)) {
          next();
          return;
        }

        let requestedRelativePath: string;
        try {
          requestedRelativePath = decodeURIComponent(
            pathname.slice(excalidrawFontUrlPrefix.length),
          );
        } catch {
          response.statusCode = 400;
          response.end();
          return;
        }

        const requestedFile = resolve(excalidrawFontSourceDirectory, requestedRelativePath);
        const sourceRelativePath = relative(excalidrawFontSourceDirectory, requestedFile);
        const isContainedFont =
          sourceRelativePath.endsWith('.woff2') &&
          sourceRelativePath !== '..' &&
          !sourceRelativePath.startsWith(`..${sep}`) &&
          !isAbsolute(sourceRelativePath);

        if (!isContainedFont) {
          next();
          return;
        }

        void readFile(requestedFile)
          .then((font) => {
            response.statusCode = 200;
            response.setHeader('Content-Type', 'font/woff2');
            response.end(font);
          })
          .catch((error: unknown) => {
            if (hasErrorCode(error, 'ENOENT')) {
              next();
              return;
            }
            next(error);
          });
      });
    },
    async writeBundle() {
      if (buildOutputDirectory === undefined) {
        throw new Error('Vite did not resolve an output directory for Excalidraw font assets.');
      }

      await cp(
        excalidrawFontSourceDirectory,
        resolve(buildOutputDirectory, 'excalidraw-assets/fonts'),
        { recursive: true },
      );
    },
  };
}

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
  return `default-src 'self'; script-src 'self' 'sha256-qzYt63qWJpMm2Kfb4Wr8UDbUtUgweR4Gv4rs133db2w='; style-src 'self' 'unsafe-inline'; img-src 'self' http: https: data: blob:; font-src 'self'; connect-src 'self' ${origin}; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'`;
}

const objectStorePublicOrigin = parseObjectStorePublicOrigin(
  process.env.NIX_OBJECT_STORE_PUBLIC_ORIGIN ?? 'http://localhost:7070',
);
const browserPolicy = contentSecurityPolicy(objectStorePublicOrigin);
// The React plugin injects a development-only inline preamble. Production and static preview keep
// the hash-only policy; the dev server is local tooling and must permit that preamble to run.
const developmentBrowserPolicy = browserPolicy.replace(
  /script-src 'self' [^;]+/u,
  "script-src 'self' 'unsafe-inline'",
);

export default defineConfig({
  // Excalidraw's published bundle imports roughjs without its file extension. Vite's browser
  // resolver accepts that path, while Node 25 (used by Vitest) does not.
  resolve: {
    alias: {
      'roughjs/bin/rough': roughjsEntry,
    },
  },
  server: {
    headers: { 'Content-Security-Policy': developmentBrowserPolicy },
    // The app consumes workspace packages as source. In the local browser this can cause the
    // React Refresh wrapper for a package module to run before its HTML preamble, preventing
    // React from mounting at all. Reloading is a reliable development fallback; it leaves the
    // production bundle untouched.
    hmr: false,
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
      name: 'nix-pwa-assets',
      async generateBundle(_options, bundle) {
        const assets = Object.keys(bundle)
          .filter((name) => /^assets\/.*\.(?:js|css|woff2)$/.test(name))
          .map((name) => `/${name}`);
        const offline = await readFile(new URL('./public/offline.html', import.meta.url), 'utf8');
        const worker = await readFile(
          new URL('./public/service-worker.js', import.meta.url),
          'utf8',
        );
        const version = createHash('sha256')
          .update(JSON.stringify(assets))
          .update(worker)
          .update(offline)
          .digest('hex')
          .slice(0, 16);
        const offlineCss = assets.find((name) => /^\/assets\/index-.*\.css$/.test(name));
        if (!offlineCss) throw new Error('The offline screen stylesheet is missing.');
        this.emitFile({
          type: 'asset',
          fileName: 'offline.html',
          source: offline.replace('/src/app.css', offlineCss),
        });
        this.emitFile({
          type: 'asset',
          fileName: 'service-worker.js',
          source: worker
            .replace("'nix-pwa-dev'", JSON.stringify(`nix-pwa-${version}`))
            .replace(
              /const SHELL_ASSETS = \[.*?\];/s,
              `const SHELL_ASSETS = ${JSON.stringify(['/offline.html', '/nix-icon-192.png', '/nix-icon-512.png', offlineCss])};`,
            )
            .replace(
              "const ASSETS = ['/offline.html', '/nix-icon-192.png', '/nix-icon-512.png'];",
              `const ASSETS = ${JSON.stringify(['/offline.html', '/nix-icon-192.png', '/nix-icon-512.png', ...assets])};`,
            ),
        });
      },
    },
    excalidrawFontAssets(),
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
    server: {
      deps: { inline: ['@excalidraw/excalidraw', 'roughjs'] },
    },

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
