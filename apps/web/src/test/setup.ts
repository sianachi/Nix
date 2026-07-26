import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

import { stubCoreApi } from './api-stub';
import { resetSession } from './render-with-router';

/**
 * Vitest runs with `globals: false`, so describe/it/expect are imported
 * explicitly in every suite. That also means Testing Library cannot register
 * its own automatic cleanup - it looks for a global afterEach - so it is
 * registered here, once, for the whole app.
 */
// The shell asks Core for the caller and the workspace on every mount. Without a stub, every
// suite would be a suite about failed requests; tests that care about a particular answer call
// stubCoreApi again with it.
beforeEach(() => {
  stubCoreApi();
});

afterEach(() => {
  cleanup();

  // The session store is module state and would otherwise leak a signed-in session from one test
  // into the next, which is the sort of order-dependence that only shows up on CI.
  resetSession();

  // Tests that assert on an unconfigured build stub VITE_OIDC_* to empty. Left standing, that
  // would silently unconfigure every test that ran afterwards.
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
