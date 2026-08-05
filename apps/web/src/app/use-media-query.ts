import { useCallback, useSyncExternalStore } from 'react';

/**
 * Whether the window currently matches a media query.
 *
 * The one `useSyncExternalStore`+`matchMedia` construction the shell needs, pulled out of
 * `use-narrow-viewport.ts` and `pane-state.ts`'s `useRoomForAnotherPane` once both turned out to be
 * the same hook differing only in the query string. `useSyncExternalStore` rather than an effect
 * that sets state: a media query is exactly the external store the hook exists for, and it closes
 * the gap an effect leaves - a window resized between render and subscription is not missed -
 * while staying off the render-cascade path an effect-plus-`setState` would put it on.
 *
 * **Guards `matchMedia`'s absence**, the way `use-theme.ts`'s `systemPrefersDark` already does:
 * it is typed as always present and is not - there is no window at all during a server render, and
 * neither caller today runs on a server, but a hook this small is cheap to make correct for one
 * that might. Answers `true` when it is missing, the same as the two callers' own prior
 * `getServerSnapshot`s - both ask a "wide/roomy enough" question, so the safe default when nothing
 * can be measured is the wide arrangement rather than a pre-emptively narrowed one.
 *
 * **One `MediaQueryList` per query, hoisted to module scope.** `matchMedia(query)` builds a new
 * object on every call, and calling it again on every render and every notification - which a
 * naive `useSyncExternalStore(subscribe, getSnapshot)` pair would do, since `getSnapshot` runs on
 * every render to check for a change - would mean throwing one away almost as fast as it is built.
 * The cache is keyed on the query string rather than one-per-hook-instance because two components
 * asking the same question should watch the same list rather than each build their own.
 *
 * The cache entry also remembers which `matchMedia` function it was built from, and rebuilds if
 * that reference has changed. In a browser it never does - `window.matchMedia` is the one function
 * for the session, and a real `MediaQueryList`'s own `matches` updates itself as the viewport
 * changes, which is what the `change` subscription above is for. In a test, though, stubbing a
 * narrower or wider answer (`stub-viewport.ts`) replaces `globalThis.matchMedia` outright rather
 * than mutating a list in place, and without this check the cache would keep answering with
 * whichever width happened to ask this exact query string first in the file.
 */
const queries = new Map<
  string,
  { readonly fn: typeof globalThis.matchMedia; readonly media: MediaQueryList }
>();

function mediaQueryList(query: string): MediaQueryList | undefined {
  const fn = globalThis.matchMedia;
  if (typeof fn !== 'function') {
    return undefined;
  }

  const cached = queries.get(query);
  if (cached?.fn === fn) {
    return cached.media;
  }

  const media = fn.call(globalThis, query);
  queries.set(query, { fn, media });
  return media;
}

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void): (() => void) => {
      const media = mediaQueryList(query);
      if (media === undefined) {
        return () => undefined;
      }

      media.addEventListener('change', onChange);
      return () => {
        media.removeEventListener('change', onChange);
      };
    },
    // Identity is `useSyncExternalStore`'s own subscribe dependency: an unstable one would tear
    // down and rebuild the listener on every render rather than only when the question changes.
    [query],
  );

  return useSyncExternalStore(
    subscribe,
    () => mediaQueryList(query)?.matches ?? true,
    () => true,
  );
}
