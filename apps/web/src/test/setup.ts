import '@testing-library/jest-dom/vitest';

import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

import { stubCoreApi } from './api-stub';
import { resetSession } from './render-with-router';

/**
 * jsdom implements `<dialog>` as far as its `open` attribute and stops: `showModal` and `close` do
 * not exist there. Anything in this application that opens a modal - the schema editor, the view
 * editor - would throw on render without them. The shim supplies exactly those two methods, which
 * lets a test exercise what a component does with a dialog without pretending to have tested the
 * top layer, the backdrop or the focus trap; those belong to the library's own stories, which run
 * in a real browser.
 *
 * Guarded, because this file is the whole app's setup and not every suite wants a DOM: a test that
 * declares `@vitest-environment node` - compiling a stylesheet, say - has no HTMLDialogElement to
 * patch and would otherwise fail here before running a line of its own.
 */
if (typeof HTMLDialogElement !== 'undefined') {
  Object.assign(HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) {
      this.open = true;
    },
    close(this: HTMLDialogElement) {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    },
  });
}

/**
 * Not Testing Library's 1000ms default, and it is the tighter of the two
 * deadlines a slow test can hit here - the other is `testTimeout` in
 * vite.config.ts, which says why it is not 5000 either.
 *
 * Every `findBy*` and `waitFor` running on real timers gives up after this
 * long. A page render that takes ~200ms alone was measured taking well over a
 * second when the full suite runs with the machine's cores saturated, and the
 * failure it produces - "Unable to find role ..." with a DOM dump - reads
 * exactly like the element genuinely never appeared. That is the expensive kind
 * of flake: nothing about it says "this was only slow".
 *
 * 5s absorbs that contention, and sits deliberately below `testTimeout` so a
 * query that really will never resolve still fails as Testing Library's
 * diagnostic rather than as a bare Vitest timeout with no DOM to look at.
 *
 * The caveat, for whoever hits it first: this is wall-clock time only while the
 * timers are real. `@testing-library/dom`'s `waitFor` arms its deadline with
 * `setTimeout(..., timeout)` before it checks whether timers are faked, so
 * under a bare `vi.useFakeTimers()` the 5000 becomes 5000 *fake* ms advanced 50
 * at a time - a longer failure path, not a longer grace period. Every
 * fake-timer suite here passes `{ shouldAdvanceTime: true }`, which walks the
 * fake clock at roughly wall-clock pace and keeps the two readings close;
 * timeline-view.test.tsx is the one file that combines fake timers with a
 * `findAllBy*` and it relies on exactly that. A suite that ever freezes the
 * clock outright should pass its own `timeout` to the query rather than lean on
 * this number.
 */
configure({ asyncUtilTimeout: 5_000 });

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
