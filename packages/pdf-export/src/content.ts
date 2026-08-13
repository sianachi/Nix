/**
 * The subset of pdfmake's document model this converter emits.
 *
 * **One optional-field interface rather than a union, because that is what pdfmake actually is.**
 * Its content model is duck-typed - a node is a text node because it has `text`, a stack because it
 * has `stack` - and a discriminated union modelling it would be a fiction the library does not
 * enforce and that every handler would have to cast through.
 *
 * Only the fields used are declared. A field pdfmake supports and this does not is a field nothing
 * here draws with, and adding one should be a deliberate edit rather than an inherited `any`.
 */

export interface PdfTableBody {
  readonly widths?: readonly (string | number)[];
  readonly headerRows?: number;
  readonly body: readonly (readonly PdfNode[])[];
}

export interface PdfNode {
  /** A leaf's characters, or a run of inline children carrying their own marks. */
  readonly text?: string | readonly PdfNode[];

  /** Blocks in flow. */
  readonly stack?: readonly PdfNode[];

  readonly ul?: readonly PdfNode[];
  readonly ol?: readonly PdfNode[];

  /** Suppresses the marker, for a task list drawing its own. */
  readonly type?: 'none';

  /** The first ordinal of an ordered list. */
  readonly start?: number;

  readonly table?: PdfTableBody;

  /** A named entry in pdfmake's `tableLayouts`, never an inline layout object. */
  readonly layout?: string;

  /** Side-by-side regions. pdfmake draws these natively; Open XML cannot. */
  readonly columns?: readonly PdfNode[];

  /** A share of the remaining width, or a fixed one. */
  readonly width?: string | number;

  /** Vector drawing, used only for the horizontal rule. */
  readonly canvas?: readonly PdfCanvasElement[];

  readonly style?: string | readonly string[];

  readonly bold?: boolean;
  readonly italics?: boolean;
  readonly decoration?: 'underline' | 'lineThrough';
  readonly color?: string;
  readonly background?: string;
  readonly link?: string;
  readonly fontSize?: number;
  readonly margin?: readonly [number, number, number, number];
  readonly preserveLeadingSpaces?: boolean;
  readonly pageBreak?: 'before';

  /** Set on the block a table of contents would point at. Present so headings can carry an id. */
  readonly id?: string;
}

export interface PdfCanvasElement {
  readonly type: 'line';
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly lineWidth: number;
  readonly lineColor: string;
}
