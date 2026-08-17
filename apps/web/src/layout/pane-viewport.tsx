import { createContext, useContext, useRef, type ReactNode, type RefObject } from 'react';

const PaneViewportContext = createContext<RefObject<HTMLDivElement | null> | null>(null);

export interface PaneViewportProps {
  readonly className: string;
  readonly children: ReactNode;
}

/** The pane-owned vertical scroller, made discoverable without DOM climbing. */
export function PaneViewport({ className, children }: PaneViewportProps): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
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
