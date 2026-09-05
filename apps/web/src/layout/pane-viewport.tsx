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
    pane.scrollTop = positions.get(scrollKey) ?? 0;
    const save = (): void => {
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
