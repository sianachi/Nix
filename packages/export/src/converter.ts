/**
 * What every export format implements, and what the host that runs one may assume.
 *
 * **A converter takes no host capability.** No filesystem, no network, no clock - `exportedAt`
 * arrives on {@link Branding} rather than being read - so a converter is a pure function from a
 * bundle stream to bytes. That is not tidiness: MVP-9's E0 turns this seam into the plugin
 * platform's import/export extension point, where a converter runs inside a sandbox that has none
 * of those things. Building it that way now means E0 changes only *where* `register` is called.
 *
 * The other reason is testability. A converter with no I/O is tested by feeding it a fixture and
 * reading its output, with no server, no temp directory and no network stub.
 */

import type { LossKind } from './loss.js';
import type { ArchiveManifest, ItemBundle } from './manifest.js';

/**
 * The formats this build can produce.
 *
 * Closed, because a format is a contract with whoever opens the file - ADR-0017 makes that argument
 * for `.nix` and it holds for the lossy ones too, which owe a stated list of what they drop.
 *
 * **`nix` is in this list and will never be in a registry.** It is produced by `writeArchive`,
 * which streams the bundles straight through without visiting a single node, and it is served by
 * the collaboration service rather than by the media service - MVP-9's E2 requires that leaving
 * with everything cannot depend on an extension seam. So `registry.formats()` is deliberately a
 * subset of this: this list is what the product can export, and a registry holds what one host
 * converts.
 */
export const EXPORT_FORMATS = ['nix', 'pdf', 'docx'] as const;

export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * Something a format cannot carry, known before any particular document is read.
 *
 * **A function of the format, never of a body.** That is what makes it sayable in time to be honest
 * about: response headers are written before the first node is visited, and the interface has to
 * tell somebody what they are about to lose *before* they press the button, not after the download
 * finishes. What a specific document actually lost is the other surface - a `LossReport`, gathered
 * while converting and written into the file itself, because the file outlives the response.
 */
export interface LossNotice {
  readonly kind: LossKind;

  /** One sentence, addressed to the person about to export. Not a log line. */
  readonly detail: string;
}

/**
 * The colours a converter draws with.
 *
 * The shape is declared here and the values live in `@nix/design-tokens`, so the seam owns what a
 * palette *is* and the token package stays the single place a colour is decided. A converter never
 * writes a colour of its own.
 */
export interface PrintPalette {
  readonly ink: string;
  readonly muted: string;
  readonly accentText: string;
  readonly accentFill: string;
  readonly surface: string;
  readonly divider: string;
  readonly calloutFill: string;
  readonly codeFill: string;
  readonly highlight: string;
}

export interface Branding {
  /** What to call the document on its first page. Usually the root item's title. */
  readonly title: string;

  /** Injected rather than read, so a converter has no clock and two runs are comparable. */
  readonly exportedAt: Date;

  readonly palette: PrintPalette;
}

export interface ConvertRequest {
  readonly manifest: ArchiveManifest;

  /**
   * The items, in the manifest's order.
   *
   * Async because the producer reads one document body at a time and releases it before the next -
   * the property that keeps an export's memory bounded by one item rather than by the whole tree.
   */
  readonly bundles: AsyncIterable<ItemBundle>;

  readonly branding: Branding;
}

export interface DocumentConverter {
  readonly format: ExportFormat;
  readonly mediaType: string;

  /** No leading dot. Used for the file name and nothing else. */
  readonly extension: string;

  /** See {@link LossNotice}. Static per format; never reads the request. */
  declaredLoss(): readonly LossNotice[];

  /**
   * The bytes of the exported file.
   *
   * **Output streams; input does not.** `.nix` is end to end streamed, but pdfmake and Open XML
   * both assemble a whole document before emitting a byte, so the bundles are consumed in full
   * first. The ceiling on that is the caller's - `EXPORT_LIMITS` upstream and a byte cap in the
   * service - not this interface's, and nobody should read the async signature as a promise of
   * constant memory.
   */
  convert(request: ConvertRequest): AsyncGenerator<Uint8Array>;
}

/**
 * A host's set of formats.
 *
 * Constructed rather than global. A module-level registry is a singleton every test has to reset
 * and no test can isolate, and it would make the plugin case - two hosts, different format sets -
 * unexpressible.
 */
export interface ConverterRegistry {
  register(converter: DocumentConverter): void;

  /** Null for a format this host does not have, so the caller answers rather than catching. */
  get(format: string): DocumentConverter | null;

  formats(): readonly ExportFormat[];
}

export function createConverterRegistry(): ConverterRegistry {
  const converters = new Map<string, DocumentConverter>();

  return {
    register(converter: DocumentConverter): void {
      if (converters.has(converter.format)) {
        // A silent overwrite would mean the format somebody gets depends on registration order,
        // which is a composition-root bug that should fail at start-up rather than at export time.
        throw new Error(`A converter for '${converter.format}' is already registered.`);
      }

      converters.set(converter.format, converter);
    },

    get(format: string): DocumentConverter | null {
      return converters.get(format) ?? null;
    },

    formats(): readonly ExportFormat[] {
      return [...converters.values()].map((converter) => converter.format);
    },
  };
}
