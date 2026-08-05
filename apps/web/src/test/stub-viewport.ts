/**
 * Stubs `matchMedia` to answer a fixed `matches` for every query - wide or narrow.
 *
 * A plain override, not `vi.stubGlobal`. `setup.ts` needs to establish this once, at module scope,
 * as the suite's persistent default, before any test's `afterEach` ever runs its
 * `vi.unstubAllGlobals()` - a value that teardown had tracked would come undone the moment the
 * first test finished, taking the desktop arrangement away from every test after it. That also
 * means there is no implicit revert here for a test to lean on between one test and the next:
 * whichever width a test wants, it calls this itself, in the test that wants it - the same way
 * `pane-state.test.tsx`'s own `panesAt` always has.
 */
export function stubViewport(wide: boolean): void {
  if (typeof globalThis.window === 'undefined') {
    return;
  }

  globalThis.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: wide,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
