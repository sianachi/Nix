import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library only auto-registers its cleanup when Vitest globals are on.
// They are off here (every helper is imported explicitly), so unmount between
// tests by hand - otherwise one test's DOM is still in the next test's
// screen queries.
afterEach(cleanup);

// No `configure({ asyncUtilTimeout })` here on purpose: these tests use no
// async utilities at all today, and the slowest of them is 703ms. If you add
// the first `findBy*` or `waitFor`, read the `asyncUtilTimeout` note in
// apps/web/src/test/setup.ts before deciding whether the 1000ms default is
// enough here too.
