import type { Offset } from './graph-layout';

/**
 * A damped spring, one step at a time.
 *
 * The layout decides where every node lives and nothing here changes that. A spring only decides
 * how a node travels between two places the layout and the reader have already agreed on - back
 * home after "Tidy up", or after a neighbour that tugged it lets go - so the arrangement stays
 * deterministic and only the journey is physical.
 *
 * Arithmetic with no clock of its own: the caller supplies the time step, so a test can step it by
 * hand and assert where it ends up.
 */

/** A node in motion: how far it is from home, and how fast that is changing. */
export interface Body {
  readonly dx: number;
  readonly dy: number;
  readonly vx: number;
  readonly vy: number;
}

/** Pull towards the goal per unit of distance. Higher is snappier. */
const STIFFNESS = 170;

/** Drag per unit of speed. Just under critical for this stiffness, so it overshoots once, slightly. */
const DAMPING = 20;

/** Close enough, and slow enough, to call it arrived. */
const REST_DISTANCE = 0.4;
const REST_SPEED = 4;

/**
 * The longest step the integrator takes at once.
 *
 * A background tab can hand back a frame a second late; integrating that as one step would fling
 * the node past its goal. Clamping makes a late frame a slow one instead.
 */
export const MAX_STEP_SECONDS = 1 / 30;

export const AT_HOME: Offset = { dx: 0, dy: 0 };

export function bodyAt(offset: Offset): Body {
  return { dx: offset.dx, dy: offset.dy, vx: 0, vy: 0 };
}

/** Semi-implicit Euler: velocity first, then position from the new velocity. Stable at this step. */
export function stepSpring(body: Body, goal: Offset, seconds: number): Body {
  const dt = Math.min(Math.max(seconds, 0), MAX_STEP_SECONDS);
  const vx = body.vx + (STIFFNESS * (goal.dx - body.dx) - DAMPING * body.vx) * dt;
  const vy = body.vy + (STIFFNESS * (goal.dy - body.dy) - DAMPING * body.vy) * dt;
  return { dx: body.dx + vx * dt, dy: body.dy + vy * dt, vx, vy };
}

export function atRest(body: Body, goal: Offset): boolean {
  return (
    Math.hypot(goal.dx - body.dx, goal.dy - body.dy) < REST_DISTANCE &&
    Math.hypot(body.vx, body.vy) < REST_SPEED
  );
}
