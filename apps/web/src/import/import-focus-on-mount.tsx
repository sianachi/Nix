import { useEffect, useRef, type ReactNode } from 'react';

/** Moves focus to the phase's first line, so the place lost with the pressed button is replaced. */
export function FocusOnMount({ children }: { readonly children: ReactNode }): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div tabIndex={-1} ref={ref}>
      {children}
    </div>
  );
}
