/**
 * pdfmake's Node printer, typed to exactly the surface this package uses.
 *
 * **Hand-written because pdfmake ships no types and `@types/pdfmake` describes the browser API.**
 * The Node entry point is a different object - a printer you construct with font descriptors and
 * ask for a PDFKit document - and the root ESLint config makes `any` an error, so the alternative
 * to this file is a cast at every call site rather than one declaration in one place.
 *
 * Narrow on purpose. Everything pdfmake can do that is not declared here is something this
 * converter does not do, and widening it should be a deliberate edit.
 */
declare module 'pdfmake' {
  import type { Readable } from 'node:stream';

  /**
   * One family's four faces, as bytes.
   *
   * Buffers rather than paths: the faces are decompressed from the woff2 that `@fontsource` ships
   * and never exist as files. pdfmake accepts either.
   */
  interface FontFaces {
    readonly normal: Buffer;
    readonly bold: Buffer;
    readonly italics: Buffer;
    readonly bolditalics: Buffer;
  }

  /** A named table layout. Only the borders and padding this package draws with are declared. */
  interface TableLayout {
    hLineWidth?: (index: number, node: unknown) => number;
    vLineWidth?: (index: number, node: unknown) => number;
    hLineColor?: (index: number, node: unknown) => string;
    vLineColor?: (index: number, node: unknown) => string;
    fillColor?: (rowIndex: number, node: unknown, columnIndex: number) => string | null;
    paddingLeft?: (index: number, node: unknown) => number;
    paddingRight?: (index: number, node: unknown) => number;
    paddingTop?: (index: number, node: unknown) => number;
    paddingBottom?: (index: number, node: unknown) => number;
  }

  interface DocumentDefinition {
    readonly content: readonly unknown[];
    readonly styles?: Readonly<Record<string, unknown>>;
    readonly defaultStyle?: Readonly<Record<string, unknown>>;
    readonly pageSize?: string;
    readonly pageMargins?: readonly [number, number, number, number];
    readonly info?: Readonly<Record<string, unknown>>;
    readonly footer?: (page: number, pages: number) => unknown;
  }

  /**
   * PDFKit's document, which is a readable stream that must be `end()`ed before it finishes.
   *
   * Typed as `Readable` plus `end` rather than as PDFKit's own class, so this package needs no
   * dependency on `@types/pdfkit` for one method.
   */
  type PdfKitDocument = Readable & { end(): void };

  class PdfPrinter {
    constructor(fonts: Readonly<Record<string, FontFaces>>);

    createPdfKitDocument(
      definition: DocumentDefinition,
      options?: { readonly tableLayouts?: Readonly<Record<string, TableLayout>> },
    ): PdfKitDocument;
  }

  export default PdfPrinter;
  export type { DocumentDefinition, FontFaces, PdfKitDocument, TableLayout };
}

declare module 'wawoff2' {
  /** woff2 is a compressed sfnt; this returns the sfnt inside it. */
  export function decompress(bytes: Uint8Array): Promise<Uint8Array>;
}
