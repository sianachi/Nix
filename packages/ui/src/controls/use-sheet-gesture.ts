import { useEffect, useRef, type RefObject } from 'react';
import type { Gesture } from '@ionic/core';

/** Ionic owns gesture recognition; the native dialog keeps focus and dismissal authority. */
export function useSheetGesture(
  dialog: RefObject<HTMLDialogElement | null>,
  handle: RefObject<HTMLButtonElement | null>,
  enabled: boolean,
  onClose: () => void,
): void {
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const sheet = dialog.current;
    const grip = handle.current;
    if (!enabled || !sheet || !grip || typeof matchMedia !== 'function') return;
    const media = matchMedia('(min-width: 640px)');
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    let disposed = false;
    let gesture: Gesture | undefined;
    const reset = (): void => {
      sheet.style.removeProperty('transform');
    };
    const sync = (): void => {
      gesture?.enable(!media.matches);
      reset();
    };
    void import('@ionic/core/components')
      .then(({ createGesture }) => {
        if (disposed) return;
        gesture = createGesture({
          el: grip,
          gestureName: 'nix-sheet-dismiss',
          direction: 'y',
          threshold: 10,
          canStart: () => sheet.open && !media.matches,
          onMove: ({ deltaY }) => {
            if (!reducedMotion.matches)
              sheet.style.transform = `translateY(${String(Math.max(0, deltaY))}px)`;
          },
          onEnd: ({ deltaY, velocityY }) => {
            reset();
            if (
              deltaY > sheet.getBoundingClientRect().height / 4 ||
              (deltaY > 24 && velocityY > 0.5)
            )
              close.current();
          },
        });
        sync();
      })
      .catch(() => {
        // The labelled close controls remain available if the optional gesture chunk fails.
      });
    media.addEventListener('change', sync);
    return () => {
      disposed = true;
      gesture?.destroy();
      media.removeEventListener('change', sync);
      reset();
    };
  }, [dialog, handle, enabled]);
}
