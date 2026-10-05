import { useEffect, useState } from 'react';

/** Collapse secondary chrome only while a text field has an occluding software keyboard. */
export function useMobileKeyboard(enabled: boolean): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const viewport = window.visualViewport;
    let baseline = window.innerHeight;
    let frame = 0;
    const measure = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const active = document.activeElement;
        const editing =
          active instanceof HTMLElement &&
          (active.isContentEditable ||
            active.matches('input:not([type=checkbox]):not([type=radio]), textarea'));
        if (!editing) baseline = window.innerHeight;
        const height = viewport?.height ?? window.innerHeight;
        const zoomed = (viewport?.scale ?? 1) !== 1;
        setVisible(editing && !zoomed && baseline - height > 120);
      });
    };
    document.addEventListener('focusin', measure);
    document.addEventListener('focusout', measure);
    viewport?.addEventListener('resize', measure);
    window.addEventListener('resize', measure);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('focusin', measure);
      document.removeEventListener('focusout', measure);
      viewport?.removeEventListener('resize', measure);
      window.removeEventListener('resize', measure);
    };
  }, [enabled]);
  return enabled && visible;
}
