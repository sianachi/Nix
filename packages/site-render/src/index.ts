/**
 * A published Nix site, rendered (ADR-0063).
 *
 * Pure: a build manifest, its pages, their bodies and their stripped images go in; every file of
 * the static site comes out, with a report of what could not be shown. The sites worker uploads
 * the result; the CLI writes it to a directory and serves it for preview.
 */

export {
  MAX_SITE_PAGES,
  SITE_PATH,
  SiteManifestError,
  parseSiteManifest,
  parseSitePages,
  type DatedCollection,
  type SiteBuildManifest,
  type SitePage,
} from './manifest.js';
export { collectFileReferences, type FileReference } from './references.js';
export { UnsupportedImage, stripImageMetadata, type StrippedImage } from './images.js';
export {
  MAX_DOWNLOAD_BYTES,
  MAX_VIDEO_BYTES,
  UnsupportedDownload,
  downloadType,
  prepareDownload,
  safeFileName,
  type PublishedDownload,
} from './downloads.js';
export {
  MAX_DIAGRAM_BYTES,
  SOURCE_HASH_ATTRIBUTE,
  UnsafeSvg,
  sanitizeSvg,
  type SanitizedSvg,
} from './svg.js';
export { renderProse, type ProseContext, type RenderedProse } from './html/prose.js';
export { escapeHtml, safeHref, slugify } from './html/escape.js';
export { buildSearchIndex, tokenize, type SearchIndex } from './search.js';
export {
  MAX_PREVIEW_IMAGES,
  renderSite,
  type RenderSiteInput,
  type RenderedFile,
  type RenderedSite,
} from './render.js';
export {
  PREVIEW_HEIGHT,
  PREVIEW_WIDTH,
  loadPreviewRasterizer,
  previewSvg,
  type PreviewRasterizer,
} from './theme/preview-image.js';
export {
  PDF_CSP,
  SITE_CSP,
  SVG_CSP,
  createPreviewServer,
  downloadHeaders,
  normalizePath,
} from './serve.js';
export { loadFixture, writeSite } from './fixture.js';
