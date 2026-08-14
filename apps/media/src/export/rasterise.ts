import { Resvg } from '@resvg/resvg-js';

/**
 * Turning a drawing into a picture.
 *
 * **The one host capability a converter asks for.** Open XML embeds pictures as raster bytes, so a
 * view drawn as SVG has to become a PNG before it can go into a Word document. Doing that needs a
 * native library, and a converter carrying one could not run inside the sandbox MVP-9's plugin seam
 * will put it in - so the service holds it and hands it over.
 *
 * **resvg, not a browser.** It is a Rust renderer with prebuilt binaries: no Chromium, no page
 * lifecycle, no JavaScript execution over content that came out of somebody's document. The
 * development document removed headless Chromium from this product for footprint, and this service
 * is the one that will eventually parse untrusted files - the less it can do, the less a parser bug
 * is worth. See ADR-0038.
 *
 * The PDF path needs none of this: pdfmake draws SVG natively, so a view stays vector there and
 * prints at whatever resolution the page is printed at.
 */
export function rasterise(svg: string, width: number): Promise<Uint8Array> {
  // Synchronous underneath - resvg renders on the calling thread - but the capability is declared
  // async so a future implementation can move off it without changing every converter.
  const rendered = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },

    // No system font loading. A drawing names its family and the fallbacks resolve from what is
    // bundled; scanning the host's font directories would make output depend on the machine, and
    // two servers would produce different files for the same document.
    font: { loadSystemFonts: false },
  }).render();

  return Promise.resolve(rendered.asPng());
}
