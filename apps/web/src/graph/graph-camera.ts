/**
 * Which part of the drawing the pane is looking at, and how closely.
 *
 * The drawing used to be painted at its full zoomed size inside a scroller, which meant a large
 * workspace opened on its top-left corner and could only be moved with scrollbars. A camera turns
 * that round: the pane is a fixed window, and `x`, `y` and `scale` say where a graph coordinate
 * lands inside it - `screen = graph * scale + offset`.
 *
 * Arithmetic only, like `graph-layout.ts` and `graph-zoom.ts`, so it is tested as arithmetic.
 */
export interface Camera {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

/**
 * The closest and furthest the camera goes.
 *
 * The floor is far below the button ladder's on purpose: a workspace at the node ceiling is many
 * thousands of units across, and "fit" has to be able to show all of it even though no named step
 * reaches that far out.
 */
export const SCALE_MIN = 0.001;
export const SCALE_MAX = 3;

export function clampScale(scale: number): number {
  return Math.min(Math.max(scale, SCALE_MIN), SCALE_MAX);
}

/**
 * The whole drawing, centred, as large as the pane allows - but never enlarged.
 *
 * A workspace of three notes magnified to fill the pane would be three enormous discs; at most
 * 100% keeps a small graph looking like the same thing a large one does.
 */
export function fitCamera(drawing: Size, pane: Size): Camera {
  if (drawing.width <= 0 || drawing.height <= 0 || pane.width <= 0 || pane.height <= 0) {
    return { x: 0, y: 0, scale: 1 };
  }

  const scale = clampScale(Math.min(pane.width / drawing.width, pane.height / drawing.height, 1));
  return {
    x: (pane.width - drawing.width * scale) / 2,
    y: (pane.height - drawing.height * scale) / 2,
    scale,
  };
}

/** The camera moved by a distance in screen pixels. */
export function panBy(camera: Camera, dx: number, dy: number): Camera {
  return { x: camera.x + dx, y: camera.y + dy, scale: camera.scale };
}

/**
 * The camera at another scale, with one screen point held still.
 *
 * Holding the pointer's own position fixed is what makes a wheel or a pinch feel like zooming into
 * the thing under the hand rather than into the corner of the drawing.
 */
export function zoomAbout(camera: Camera, scale: number, anchorX: number, anchorY: number): Camera {
  const next = clampScale(scale);
  const ratio = next / camera.scale;
  return {
    x: anchorX - (anchorX - camera.x) * ratio,
    y: anchorY - (anchorY - camera.y) * ratio,
    scale: next,
  };
}

/** The camera placed so one graph point sits in the middle of the pane. */
export function centreOn(camera: Camera, pane: Size, graphX: number, graphY: number): Camera {
  return {
    x: pane.width / 2 - graphX * camera.scale,
    y: pane.height / 2 - graphY * camera.scale,
    scale: camera.scale,
  };
}

/**
 * A camera the reader chose, independent of the pane it was chosen in: which graph point sits at
 * the middle of the pane, and how closely.
 *
 * A `Camera` is screen offsets, so it is only right for the pane size it was made in. Kept as
 * offsets, a view saved while the pane was narrow - a sidebar open, a smaller window - came back
 * shifted towards the left in a wider one, and zooming about the middle of the pane then pulled the
 * drawing further off. Keeping the centre instead means a restored or resized view stays centred.
 */
export interface View {
  readonly centreX: number;
  readonly centreY: number;
  readonly scale: number;
}

/** The view a camera shows through a pane of this size. */
export function viewOf(camera: Camera, pane: Size): View {
  return {
    centreX: (pane.width / 2 - camera.x) / camera.scale,
    centreY: (pane.height / 2 - camera.y) / camera.scale,
    scale: camera.scale,
  };
}

/** The camera that shows a view through a pane of this size. */
export function cameraOf(view: View, pane: Size): Camera {
  return centreOn({ x: 0, y: 0, scale: clampScale(view.scale) }, pane, view.centreX, view.centreY);
}

/** The SVG `viewBox` that shows what this camera sees through a pane of this size. */
export function viewBoxOf(camera: Camera, pane: Size): string {
  const left = -camera.x / camera.scale;
  const top = -camera.y / camera.scale;
  return `${String(left)} ${String(top)} ${String(pane.width / camera.scale)} ${String(pane.height / camera.scale)}`;
}
