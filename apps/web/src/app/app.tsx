import type { ReactElement } from 'react';
import { Route, Routes } from 'react-router';

import { AuthProvider } from '../auth/auth-provider';
import { AppErrorBoundary } from '../components/error-boundary';
import { AuthCallbackPage, SilentRenewPage } from '../pages/auth-callback-page';
import { AuditPage } from '../pages/audit-page';
import { EditorPage } from '../pages/editor-page';
import { NotFoundPage } from '../pages/not-found-page';
import { TokensPage } from '../pages/tokens-page';
import { AppShell } from './app-shell';
import { RequireSession } from './require-session';

/**
 * The route tree and the crash barrier that wraps it.
 *
 * react-router is used in declarative mode: routes are JSX, and there are no
 * loaders, because nothing in this app fetches yet. When the api-client lands,
 * the tree moves to data mode and this file is where that happens - callers
 * only ever see <App />.
 *
 * The error boundary sits inside the router on purpose. A crash in a page
 * leaves the router mounted, so recovery re-renders the current route instead
 * of reloading the document and losing the URL state.
 *
 * <App /> expects a router above it. main.tsx supplies BrowserRouter; tests
 * supply MemoryRouter, which is what makes the URL-state convention testable
 * without a browser.
 *
 * The outer element carries the token-backed page defaults - light ground, ink
 * foreground, Barlow body - so they survive even when a crash replaces the
 * whole route tree with the error fallback.
 */
export function App(): ReactElement {
  return (
    <div className="min-h-screen bg-background font-body text-foreground">
      <AppErrorBoundary>
        <AuthProvider>
          <Routes>
            {/* Outside the session gate: these two ARE the sign-in process. */}
            <Route path="/auth/callback" element={<AuthCallbackPage />} />
            <Route path="/auth/silent-renew" element={<SilentRenewPage />} />

            <Route element={<RequireSession />}>
              <Route element={<AppShell />}>
                {/* One workspace, one place to be. The board is a view of a container rather
                    than a destination, and search opens over whatever is on screen, so neither
                    has a route of its own. */}
                <Route index element={<EditorPage />} />

                {/* Behind the profile menu, and offered only to a tenant administrator - which
                    the server decides, not a token claim. The route itself is not the guard:
                    every endpoint it calls asks the database for itself. */}
                <Route path="settings/audit" element={<AuditPage />} />

                <Route path="tokens" element={<TokensPage />} />
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Route>
          </Routes>
        </AuthProvider>
      </AppErrorBoundary>
    </div>
  );
}
