import type { PrintPalette, SchemaSnapshot, ViewSnapshot } from '@nix/export';

/**
 * What a view needs to be drawn, and what drawing one produces.
 *
 * **A view is a way of looking at an item's children, so drawing one needs the children.** They
 * arrive as rows rather than as whole bundles: a board card shows a title and a property or two,
 * never a document body, and handing the renderer everything would let it reach for things a
 * picture cannot show anyway.
 */

/** One child, as much of it as a view can show. */
export interface ViewRow {
  readonly id: string;
  readonly title: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

export interface RenderRequest {
  readonly view: ViewSnapshot;

  /** The children, already in the order the view wants them. */
  readonly rows: readonly ViewRow[];

  /** The effective schema at the parent, for property labels and types. */
  readonly schema: SchemaSnapshot | null;

  readonly palette: PrintPalette;

  /** How wide the drawing may be, in points. The height follows from the content. */
  readonly width: number;
}

/**
 * A drawn view.
 *
 * The dimensions come back with the markup because both consumers need them and neither can get
 * them from the string without parsing it: a PDF places the picture in a column of known width, and
 * a Word document needs a pixel size for the raster it embeds.
 */
export interface RenderedView {
  readonly svg: string;
  readonly width: number;
  readonly height: number;

  /**
   * What this drawing could not show, beyond the fact that it is a drawing.
   *
   * Empty for a view that came across whole. A gallery whose covers live at URLs is the usual
   * entry: the export cannot fetch a picture, so the tiles are drawn empty and say so.
   */
  readonly notes: readonly string[];
}
