import type { ReactElement } from 'react';
import { Link, Outlet } from 'react-router';

import { Heading, Kicker, Text } from '../components/typography';

/**
 * The application shell: header bar, main region, footer.
 *
 * The page ground, ink and body family are set by <App /> so they survive a
 * crash; this element only owns the vertical structure and the shared chrome.
 *
 * The skip link is here rather than per page: keyboard users get one, always,
 * and it is the first focusable thing in the document.
 */
export function RootLayout(): ReactElement {
  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main"
        className="sr-only px-4 py-2 focus:not-sr-only focus:absolute focus:bg-background focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        Skip to content
      </a>

      <header className="border-b border-divider">
        <div className="mx-auto flex w-full max-w-6xl items-baseline justify-between gap-6 px-6 py-4">
          <Link
            to="/"
            className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <Heading level={4}>Nix</Heading>
          </Link>
          <Kicker tone="muted">Collaborative document workspace</Kicker>
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
        <Outlet />
      </main>

      <footer className="border-t border-divider">
        <div className="mx-auto w-full max-w-6xl px-6 py-4">
          <Text tone="muted" size="xs">
            Rendered entirely from the Industry design tokens.
          </Text>
        </div>
      </footer>
    </div>
  );
}
