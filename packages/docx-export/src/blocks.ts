import type { ParagraphChild } from 'docx';

/**
 * What a handler produces, before it becomes Open XML.
 *
 * **An intermediate representation, and it is not ceremony.** `docx` reads a `Paragraph`'s options
 * at construction and exposes none of them afterwards, so there is no supported way to say "this
 * paragraph, but as a list item at level 2" once it exists. A mapper that builds paragraphs eagerly
 * has to rebuild them to decorate them - and rebuilding one silently drops its children, which is a
 * bug that produces an empty bullet rather than an error.
 *
 * Describing a paragraph first and constructing it once, at the end, makes that class of mistake
 * unexpressible: decoration is a field, not a reconstruction.
 */

export interface ParagraphSpec {
  readonly kind: 'paragraph';
  readonly inlines: readonly ParagraphChild[];

  readonly heading?: 1 | 2 | 3;

  /** Indentation in twentieths of a point, Open XML's unit. */
  readonly indentLeft?: number;

  readonly leftRule?: string;
  readonly bottomRule?: string;
  readonly shading?: string;
  readonly monospace?: boolean;
  readonly spacingAfter?: number;

  /** A list marker. `numbering` uses the shared ordered definition; `bullet` uses Word's own. */
  readonly list?: { readonly kind: 'bullet' | 'number'; readonly level: number };
}

export interface CellSpec {
  readonly blocks: readonly BlockSpec[];
  readonly shading?: string;
  readonly widthPercent?: number;
}

export interface TableSpec {
  readonly kind: 'table';
  readonly rows: readonly (readonly CellSpec[])[];

  /** A callout, an image placeholder and a column row are all tables nobody should see as one. */
  readonly borderless?: boolean;

  readonly headerRow?: boolean;
}

export type BlockSpec = ParagraphSpec | TableSpec;

export function paragraph(
  inlines: readonly ParagraphChild[],
  extra: Omit<ParagraphSpec, 'kind' | 'inlines'> = {},
): ParagraphSpec {
  return { kind: 'paragraph', inlines, ...extra };
}

/** Applies a decoration to every paragraph in a run of blocks, leaving tables alone. */
export function decorate(
  blocks: readonly BlockSpec[],
  extra: Omit<ParagraphSpec, 'kind' | 'inlines'>,
): readonly BlockSpec[] {
  return blocks.map((block) => (block.kind === 'paragraph' ? { ...block, ...extra } : block));
}
