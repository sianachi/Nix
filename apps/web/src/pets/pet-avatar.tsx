import { Text } from '@nix/ui';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { PetProfile, PetSettings } from '@nix/api-client';
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
  appearance = 'owl',
  state = 'idle',
  motion = 'system',
  label = 'Owl companion',
}: {
  readonly appearance?: PetProfile['appearance'];
  readonly state?: PetAnimationState;
  readonly motion?: PetSettings['motion'];
  readonly label?: string;
}): ReactElement {
  return appearance === 'owl' ? (
    <OwlAvatar state={state} motion={motion} label={label} />
  ) : (
    <svg
      viewBox="0 0 100 100"
      role="img"
      aria-label={label}
      className="size-24 shrink-0 text-accent"
      data-state={state}
    >
      <path
        d={
          appearance === 'fox'
            ? 'M18 12 38 28 62 28 82 12 85 55 50 88 15 55Z'
            : 'M18 15 38 30 62 30 82 15 85 65 Q50 92 15 65Z'
        }
        fill="currentColor"
      />
      <path d="M24 46Q37 42 50 57Q63 42 76 46L68 70Q50 84 32 70Z" className="fill-background" />
      <path
        d={state === 'success' ? 'M29 48Q35 40 41 48 M59 48Q65 40 71 48' : 'M32 46V51 M68 46V51'}
        className="stroke-foreground"
        strokeWidth="4"
        strokeLinecap="round"
        fill="none"
      />
      <path d="M44 59H56L50 65Z" className="fill-foreground" />
      {state === 'speaking' || state === 'listening' ? (
        <ellipse cx="50" cy="71" rx="5" ry="4" className="fill-foreground" />
      ) : (
        <path d="M43 70Q50 76 57 70" className="stroke-foreground" fill="none" strokeWidth="2" />
      )}
      {state === 'thinking' || state === 'working' ? (
        <circle
          cx="86"
          cy="20"
          r="6"
          className={`fill-foreground ${motion === 'full' ? 'animate-pulse' : motion === 'system' ? 'motion-safe:animate-pulse' : ''}`}
        />
      ) : null}
      {state === 'error' || state === 'awaiting-approval' ? (
        <path d="M88 29V39M88 45V47" className="stroke-foreground" strokeWidth="3" />
      ) : null}
    </svg>
  );
}

function OwlAvatar({
  state,
  motion,
  label,
}: {
  readonly state: PetAnimationState;
  readonly motion: PetSettings['motion'];
  readonly label: string;
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
