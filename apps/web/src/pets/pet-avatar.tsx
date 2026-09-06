import { Text } from '@nix/ui';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { PetSettings } from '@nix/api-client';
import atlas from './owl-atlas.json';

export const petAnimationStates = [
  'idle',
  'hover',
  'listening',
  'thinking',
  'working',
  'awaiting-approval',
  'speaking',
  'success',
  'error',
] as const;
export type PetAnimationState = (typeof petAnimationStates)[number];

/** Playback state is supplied by the caller; animation never starts work or audio. */
export function PetAvatar({
  state = 'idle',
  motion = 'system',
  label = 'Owl companion',
}: {
  readonly state?: PetAnimationState;
  readonly motion?: PetSettings['motion'];
  readonly label?: string;
}): ReactElement {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context) return;
    const picture = new Image();
    const reduced = globalThis.matchMedia('(prefers-reduced-motion: reduce)');
    let disposed = false;
    let loaded = false;
    let inViewport = true;
    let frameRequest = 0;
    let epoch = 0;
    let previous = -1;
    const row = petAnimationStates.indexOf(state);
    const sourceTop = atlas.rowStarts[row] ?? 0;
    const sourceHeight = atlas.rowHeights[row] ?? atlas.cellWidth;
    const baseline = atlas.rowBaselines[row] ?? 197;
    const idleFrames = [0, 0, 0, 0, 0, 0, 1, 2, 3];
    const moving = () => motion !== 'reduced' && (motion !== 'system' || !reduced.matches);
    function draw(frame: number): void {
      if (!context || !element || !loaded || frame === previous) return;
      previous = frame;
      context.clearRect(0, 0, element.width, element.height);
      context.drawImage(
        picture,
        frame * atlas.cellWidth,
        sourceTop,
        atlas.cellWidth,
        sourceHeight,
        0,
        ((197 - baseline) * element.height) / atlas.cellWidth,
        element.width,
        (sourceHeight * element.height) / atlas.cellWidth,
      );
    }
    function tick(now: number): void {
      if (disposed || !loaded || document.hidden || !inViewport || !moving()) return;
      if (epoch === 0) epoch = now;
      const step = Math.floor((now - epoch) / atlas.frameDurationMs);
      draw(state === 'idle' ? (idleFrames[step % idleFrames.length] ?? 0) : step % atlas.columns);
      frameRequest = requestAnimationFrame(tick);
    }
    function sync(): void {
      cancelAnimationFrame(frameRequest);
      epoch = 0;
      draw(0);
      if (loaded && !disposed && !document.hidden && inViewport && moving())
        frameRequest = requestAnimationFrame(tick);
    }
    picture.onload = () => {
      if (disposed) return;
      if (
        picture.naturalWidth !== atlas.imageWidth ||
        picture.naturalHeight !== atlas.imageHeight
      ) {
        setFailed(true);
        return;
      }
      loaded = true;
      sync();
    };
    picture.onerror = () => {
      if (!disposed) setFailed(true);
    };
    picture.src = `/pets/${atlas.source}`;
    const observer =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver((entries) => {
            inViewport = entries.some((entry) => entry.isIntersecting);
            sync();
          });
    observer?.observe(element);
    document.addEventListener('visibilitychange', sync);
    reduced.addEventListener('change', sync);
    return () => {
      disposed = true;
      cancelAnimationFrame(frameRequest);
      observer?.disconnect();
      document.removeEventListener('visibilitychange', sync);
      reduced.removeEventListener('change', sync);
      picture.onload = null;
      picture.onerror = null;
    };
  }, [state, motion]);
  return failed ? (
    <Text variant="note">Owl preview unavailable</Text>
  ) : (
    <canvas
      ref={canvas}
      width={192}
      height={192}
      role="img"
      aria-label={label}
      className="size-24 shrink-0"
    />
  );
}
