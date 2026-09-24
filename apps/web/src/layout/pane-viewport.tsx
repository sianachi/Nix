import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';

const positions = new Map<string, number>();

const PaneViewportContext = createContext<RefObject<HTMLDivElement | null> | null>(null);

export interface PaneViewportProps {
  readonly className: string;
  readonly scrollKey?: string;
  readonly children: ReactNode;
}

/** The pane-owned vertical scroller, made discoverable without DOM climbing. */
export function PaneViewport({ className, children, scrollKey }: PaneViewportProps): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const pane = ref.current;
    if (!pane || !scrollKey) return;
    const target = positions.get(scrollKey) ?? 0;

    // The pane's content - async, most of the time - has not necessarily grown tall enough yet
    // for `target` to be a reachable `scrollTop`: the assignment above gets silently clamped to
    // whatever the empty or partial pane can currently scroll to, which is 0 more often than not.
    // A `ResizeObserver` on the pane itself notices every later growth (a page's blocks arriving,
    // an image finishing layout) and retries the same assignment, so the restore lands once there
    // is finally room for it rather than only on the frame that happened to run first.
    let settled = false;
    const tryRestore = (): void => {
      if (settled) return;
      const reachable = pane.scrollHeight - pane.clientHeight;
      if (reachable >= target) {
        pane.scrollTop = target;
        settled = true;
        observer?.disconnect();
      }
    };

    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            tryRestore();
          });
    observer?.observe(pane);
    tryRestore();

    const save = (): void => {
      // Any scroll the pane did not just make on this effect's own behalf is somebody looking
      // somewhere else on purpose - the observer above must not then drag them back to `target`
      // once the content grows further.
      settled = true;
      observer?.disconnect();
      positions.delete(scrollKey);
      positions.set(scrollKey, pane.scrollTop);
      if (positions.size > 100) {
        const oldest = positions.keys().next().value;
        if (oldest !== undefined) positions.delete(oldest);
      }
    };
    pane.addEventListener('scroll', save, { passive: true });
    return () => {
      save();
      pane.removeEventListener('scroll', save);
      observer?.disconnect();
    };
  }, [scrollKey]);
  return (
    <PaneViewportContext.Provider value={ref}>
      <div ref={ref} data-pane-viewport="true" className={className}>
        {children}
      </div>
    </PaneViewportContext.Provider>
  );
}

export function usePaneViewport(): RefObject<HTMLDivElement | null> | null {
  return useContext(PaneViewportContext);
}
