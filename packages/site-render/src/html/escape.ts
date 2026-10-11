/**
 * Escaping for every string a site page interpolates. Page content is written by workspace
 * members and read by anonymous visitors, so nothing reaches markup without passing through here.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A link target a page may carry, or null.
 *
 * Only http(s) and mailto addresses, same-site paths and fragments are allowed. Anything else -
 * `javascript:`, `data:`, a scheme-relative `//host` - is refused rather than neutralised, and the
 * caller renders the text without a link. Control characters and whitespace inside a scheme are
 * stripped before the check, because browsers ignore them when they parse one.
 */
export function safeHref(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  const value = raw.trim();
  if (value.length === 0 || value.length > 2048) {
    return null;
  }
  if (value.startsWith('#') || (value.startsWith('/') && !value.startsWith('//'))) {
    return value;
  }
  // eslint-disable-next-line no-control-regex -- Justification: stripping control characters is the point.
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value.replace(/[\u0000- ]/g, ''));
  if (scheme === null) {
    return null;
  }
  const name = (scheme[1] ?? '').toLowerCase();
  return name === 'http' || name === 'https' || name === 'mailto' ? value : null;
}

/** A heading's anchor: lowercase words joined by hyphens, never empty. */
export function slugify(value: string, fallback = 'section'): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug.length === 0 ? fallback : slug;
}
