import { useMediaQuery } from './use-media-query';

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
 * are one-liners over the shared `useMediaQuery`.
 *
 * **Phrased as "is it wide enough", not "is it narrow".** The test setup stubs `matchMedia` to
 * answer `matches: true` for any query by default, so an ordinary render exercises the desktop
 * arrangement unless a test deliberately asks about a narrow one. Asking `(max-width: ...)` instead
 * would read as narrow under that same default and flip every existing test that never mentions a
 * viewport onto the drawer path.
 */
const WIDE_ENOUGH_FOR_A_FIXED_SIDEBAR = '(min-width: 640px)';

export function useNarrowViewport(): boolean {
  return !useMediaQuery(WIDE_ENOUGH_FOR_A_FIXED_SIDEBAR);
}
