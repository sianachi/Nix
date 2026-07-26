import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library only auto-registers its cleanup when Vitest globals are on.
// They are off here (every helper is imported explicitly), so unmount between
// tests by hand - otherwise one test's DOM is still in the next test's
// screen queries.
afterEach(cleanup);
