import { createConverterRegistry, type ConverterRegistry } from '@nix/export';
import { docxConverter } from '@nix/docx-export';
import { markdownConverter } from '@nix/markdown';
import { pdfConverter } from '@nix/pdf-export';

/**
 * The formats this service produces.
 *
 * **The composition root for conversion, and the only place a format is named.** Registration is one
 * line each, explicit, with no scanning - the same discipline Core's dispatcher uses, and for the
 * same reason: a format that is not registered fails here, at start-up, rather than on the first
 * request that wanted it.
 *
 * `.nix` is deliberately absent. It is produced by the collaboration service, which holds the
 * document log, and MVP-9's E2 requires that leaving with everything cannot depend on a converter
 * seam at all.
 *
 * When E0's plugin platform lands, this function is what it replaces: the interface and the registry
 * stay, and only the place `register` is called moves.
 */
export function createConverters(): ConverterRegistry {
  const registry = createConverterRegistry();

  registry.register(pdfConverter);
  registry.register(docxConverter);
  registry.register(markdownConverter);

  return registry;
}
