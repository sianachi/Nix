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

// jsdom performs no layout and implements no scrolling, so `Element.scrollIntoView` is simply
// absent. `<Listbox>` calls it to keep the highlighted option in view - the browser will not do it
// for us, because focus deliberately never enters the list - so without this every test that
// renders one throws on the first render rather than failing an assertion.
//
// Shimmed rather than guarded in the component, matching how `Dialog.test.tsx` handles jsdom's
// missing `showModal`: the gap belongs to the environment, and a component that checked for it
// would be carrying a test concern into the product.
// Guarded on `Element` itself as well: not every suite in this project runs in jsdom - the
// stylesheet test runs in node, where there is no DOM at all to patch.
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {
    // Nothing to scroll: jsdom has no viewport.
  };
}
