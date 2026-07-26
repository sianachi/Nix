import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * Vitest runs with `globals: false`, so describe/it/expect are imported
 * explicitly in every suite. That also means Testing Library cannot register
 * its own automatic cleanup - it looks for a global afterEach - so it is
 * registered here, once, for the whole app.
 */
afterEach(() => {
  cleanup();
});
