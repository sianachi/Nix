import { useCallback, useSyncExternalStore } from 'react';

import { NARROWEST_FOR_TWO_PANES, WIDE_ENOUGH_FOR_A_FIXED_SIDEBAR } from './regions';

/**
 * How the layout asks about the window.
 *
 * Both questions in this file are about the *window* rather than about any one box: whether the
 * shell has room to hold the workspace tree beside its content, and - in `pane-state.ts` - whether
 * it has room for a second pane. Neither is a container query, because neither is a question a
 * container can answer.
 */

/**
 * Whether the window currently matches a media query.
 *
 * The one `useSyncExternalStore`+`matchMedia` construction the shell needs, pulled out of
 * `useNarrowViewport` below and `pane-state.ts`'s `useRoomForAnotherPane` once both turned out to
 * be the same hook differing only in the query string. `useSyncExternalStore` rather than an effect
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

/**
 * Whether the window is narrower than Tailwind's own `sm` breakpoint (640px) - the cutoff this
 * codebase already reaches for whenever a layout changes shape on a phone (`gallery-view.tsx`'s
 * `sm:grid-cols-2`, `timeline-view.tsx`'s `sm:min-w-[12rem]`). There are no custom breakpoint
 * tokens in `packages/design-tokens`, so this uses the number Tailwind's own utility classes
 * already use rather than inventing a second one.
 *
 * **A window query, not a container query.** What is being decided is whether the *shell* has room
 * to hold the workspace tree beside its content, which is a question about the window - the same
 * reasoning `pane-state.ts`'s `useRoomForAnotherPane` gives for its own, larger breakpoint. Both
 * are one-liners over the shared `useMediaQuery` above.
 *
 * **Phrased as "is it wide enough", not "is it narrow".** The test setup stubs `matchMedia` to
 * answer `matches: true` for any query by default, so an ordinary render exercises the desktop
 * arrangement unless a test deliberately asks about a narrow one. Asking `(max-width: ...)` instead
 * would read as narrow under that same default and flip every existing test that never mentions a
 * viewport onto the drawer path.
 */
export function useNarrowViewport(): boolean {
  return !useMediaQuery(WIDE_ENOUGH_FOR_A_FIXED_SIDEBAR);
}

/**
 * Whether the window is currently wide enough for more than one pane.
 *
 * A one-liner over the shared `useMediaQuery` - see that hook's own comment for why it is
 * `useSyncExternalStore` rather than an effect that sets state, and for the server/no-`matchMedia`
 * default: there is no window to measure, so the arrangement the address asks for is rendered
 * whole rather than pre-emptively narrowed to something the client may not want.
 *
 * It sits here rather than in `pane-state.ts`, where it was written, because it is the same
 * question `useNarrowViewport` asks one breakpoint lower: has the shell room for another region.
 * Both thresholds are declared together in `regions.ts` so the pair can be read as a pair.
 */
export function useRoomForAnotherPane(): boolean {
  return useMediaQuery(`(min-width: ${String(NARROWEST_FOR_TWO_PANES)}px)`);
}
