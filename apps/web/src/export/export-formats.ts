/**
 * The formats a document can leave in, and what each one costs.
 *
 * **The `preamble` is the honest part and it is shown before the export runs, never after.** A
 * download starting is evidence that something happened and no evidence at all of what is in it, so
 * somebody choosing PDF is told what a page cannot carry while they can still choose otherwise.
 * MVP-9's exit criterion asks for exactly this: every lossy path states what it loses *before* it
 * runs.
 *
 * These sentences are a summary. The authoritative list is each converter's `declaredLoss()`, and
 * every one of those is asserted to cover what a document of every block actually loses - so the
 * guarantee is enforced in the converter packages, where it can be, rather than restated here as a
 * claim nothing checks. The file the export produces ends with the same list, item by item.
 *
 * The two lossy formats come from the media service and the lossless one from the collaboration
 * service, which is why the base URL is a property of the format rather than a constant: `.nix` is
 * Core's promise that you can leave with everything, and it cannot depend on a converter seam.
 */

export type ExportFormat = 'nix' | 'pdf' | 'docx' | 'md';

export interface FormatDescriptor {
  readonly value: ExportFormat;

  /** What the picker shows. */
  readonly label: string;

  /** No leading dot; the file name puts it there. */
  readonly extension: string;

  /** Which service produces it. */
  readonly baseUrl: string;

  /** What this format is for, and what it will not carry. Read before Export is pressed. */
  readonly preamble: string;

  /** Where the produced file states what it lost, named so the partial notice can point at it. */
  readonly reportLocation: string;
}

export const EXPORT_FORMATS: readonly FormatDescriptor[] = [
  {
    value: 'nix',
    label: 'Archive',
    extension: 'nix',
    baseUrl: '/collab',
    preamble:
      'A .nix archive keeps everything: the text, the properties, the fields and views, and the order things are in. It is the format that can be brought back without losing anything.',
    reportLocation: "The archive's manifest names each one.",
  },
  {
    value: 'pdf',
    label: 'PDF',
    extension: 'pdf',
    baseUrl: '/media',
    preamble:
      'A PDF is for reading and printing. Boards, calendars and galleries are drawn as pictures, so they show what they showed but cannot be sorted or clicked. Comments, the links between your items, and images stored elsewhere do not come across, a collapsed section is printed open, and a spreadsheet shows its values rather than its formulas. The last page lists exactly what was left out.',
    reportLocation: 'The last page of the file names each one.',
  },
  {
    value: 'docx',
    label: 'Word',
    extension: 'docx',
    baseUrl: '/media',
    preamble:
      'A Word document is for editing somewhere else. Boards, calendars and galleries become pictures, so they show what they showed but cannot be edited. Comments, the links between your items, and images stored elsewhere do not come across; side-by-side columns become a borderless table, a collapsed section is written out open, and a spreadsheet shows its values rather than its formulas. The last section lists exactly what was left out.',
    reportLocation: 'The last section of the file names each one.',
  },
  {
    value: 'md',
    label: 'Markdown',
    extension: 'md',
    baseUrl: '/media',
    preamble:
      'Markdown is plain text you can read and edit anywhere. Comments do not come across, text colour and highlighting are lost, and side-by-side columns become a single column. Boards, calendars and galleries are not shown, because Markdown cannot draw a view. Your links and images are kept. The end of the file lists exactly what was left out.',
    reportLocation: 'The end of the file lists each one.',
  },
];

export function formatFor(value: ExportFormat): FormatDescriptor {
  const descriptor = EXPORT_FORMATS.find((format) => format.value === value);

  if (descriptor === undefined) {
    // Unreachable while the union and the list agree, which `export-formats.test.ts` asserts. A
    // throw rather than a silent fallback, because falling back would mean exporting a format
    // somebody did not ask for.
    throw new Error(`There is no export format called '${value}'.`);
  }

  return descriptor;
}
