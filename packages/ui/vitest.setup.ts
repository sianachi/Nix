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

// jsdom implements MouseEvent but not PointerEvent until 27, and this package is deliberately
// still on 26: bumping it to apps/web's 29 was tried and changes how jsdom serialises a `style`
// attribute (`url("#x")` rather than `url(#x)`), which fails `Duotone.test.tsx` on a point that
// has nothing to do with any component here. The pin moves with that test, not with this shim.
//
// Shimmed for the same reason as `scrollIntoView` above: the gap belongs to the environment, and
// `<PaneDivider>`'s drag tests construct real PointerEvents. Only the two fields the window
// splitter reads beyond MouseEvent's are carried. `defineProperty` rather than a cast, so the
// assignment does not have to erase the window's type to land.
if (typeof window !== 'undefined' && typeof window.PointerEvent === 'undefined') {
  class PointerEventShim extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;

    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? '';
    }
  }

  Object.defineProperty(window, 'PointerEvent', {
    value: PointerEventShim,
    configurable: true,
    writable: true,
  });
}
