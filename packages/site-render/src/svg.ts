/**
 * A Mermaid diagram's captured SVG, made safe to publish (ADR-0063).
 *
 * The author's browser captures the picture and an untrusted client uploads it, so the bytes are
 * parsed here by a strict XML reader and **written out again from scratch**: only allowlisted
 * elements and attributes survive, every value is re-escaped, and anything the reader does not
 * understand fails the whole picture rather than passing through. The same function runs on
 * capture (in the browser, before upload) and at build (in the worker, before publishing).
 *
 * Refused outright: a DOCTYPE or entity declaration (no entity expansion), unknown named
 * entities, and malformed markup. Dropped: scripts, `foreignObject`, embedded images, event
 * handlers, any reference that is not to an element of the same picture (`#id`), and CSS that
 * loads anything (`url()` other than `#id`, `@import`).
 *
 * Pure and DOM-free, so the browser and Node share it.
 */

export const MAX_DIAGRAM_BYTES = 2 * 1024 * 1024;

/** The root attribute that ties a picture to the exact source it was drawn from. */
export const SOURCE_HASH_ATTRIBUTE = 'data-nix-source-sha256';

export class UnsafeSvg extends Error {
  override readonly name = 'UnsafeSvg';
}

export interface SanitizedSvg {
  readonly svg: string;
  readonly width: number | null;
  readonly height: number | null;
  /** The SHA-256 of the Mermaid source the picture was captured from, when it carries one. */
  readonly sourceSha256: string | null;
}

const ELEMENTS = new Set([
  'svg',
  'g',
  'defs',
  'style',
  'title',
  'desc',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'marker',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'mask',
  'pattern',
  'symbol',
  'use',
  'filter',
  'feBlend',
  'feColorMatrix',
  'feComposite',
  'feDropShadow',
  'feFlood',
  'feGaussianBlur',
  'feMerge',
  'feMergeNode',
  'feMorphology',
  'feOffset',
]);

/** Kept for their children only: a link's target is dropped, its drawing is not. */
const UNWRAPPED = new Set(['a', 'switch']);

const ATTRIBUTES = new Set([
  'id',
  'class',
  'style',
  'transform',
  'd',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'fx',
  'fy',
  'width',
  'height',
  'viewBox',
  'preserveAspectRatio',
  'points',
  'pathLength',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-opacity',
  'opacity',
  'color',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'dominant-baseline',
  'alignment-baseline',
  'baseline-shift',
  'dx',
  'dy',
  'rotate',
  'textLength',
  'lengthAdjust',
  'letter-spacing',
  'word-spacing',
  'text-decoration',
  'marker-start',
  'marker-mid',
  'marker-end',
  'markerWidth',
  'markerHeight',
  'markerUnits',
  'refX',
  'refY',
  'orient',
  'offset',
  'stop-color',
  'stop-opacity',
  'gradientUnits',
  'gradientTransform',
  'spreadMethod',
  'clip-path',
  'clip-rule',
  'clipPathUnits',
  'mask',
  'maskUnits',
  'maskContentUnits',
  'patternUnits',
  'patternContentUnits',
  'patternTransform',
  'filter',
  'filterUnits',
  'primitiveUnits',
  'in',
  'in2',
  'result',
  'stdDeviation',
  'mode',
  'operator',
  'radius',
  'k1',
  'k2',
  'k3',
  'k4',
  'values',
  'type',
  'flood-color',
  'flood-opacity',
  'visibility',
  'display',
  'overflow',
  'role',
  'aria-label',
  'aria-labelledby',
  'aria-describedby',
  'aria-roledescription',
  'href',
  'xml:space',
]);

const DATA_ATTRIBUTE = /^data-[a-z0-9-]{1,64}$/;
const LOCAL_URL = /^url\(\s*(['"]?)#[\w.:-]+\1\s*\)$/i;
const ANY_URL = /url\s*\(([^)]*)\)/gi;
// Every CSS function that can fetch an image or another document, besides url().
const CSS_HAZARD =
  /@import|@font-face|(?:expression|image-set|image|src|cross-fade|element)\s*\(|javascript:|-moz-binding|behavior\s*:|\\|</i;
/** XML 1.0 `Char`: anything else cannot be written back out as well-formed XML. */
const NOT_XML_CHAR = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;
/** Bounds what `<use>` can multiply: how many, and that none points at a drawing holding another. */
export const MAX_USE_ELEMENTS = 2000;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_DEPTH = 256;
const MAX_NODES = 200_000;

interface Element {
  readonly name: string;
  readonly attributes: [string, string][];
  readonly children: (Element | string)[];
}

/** No CSS here may load anything: every `url()` must name an element of this picture. */
function safeCss(css: string): boolean {
  if (CSS_HAZARD.test(css)) return false;
  for (const match of css.matchAll(ANY_URL)) {
    if (!LOCAL_URL.test(match[0])) return false;
  }
  return true;
}

const PREDEFINED: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

function decode(raw: string): string {
  return raw.replace(/&([^;&\s]{0,32});?/g, (whole, name: string) => {
    if (!whole.endsWith(';')) throw new UnsafeSvg('A bare ampersand is not valid XML.');
    const predefined = PREDEFINED[name];
    if (predefined !== undefined) return predefined;
    const numeric = /^#(?:x([0-9a-f]{1,6})|([0-9]{1,7}))$/i.exec(name);
    if (numeric === null) throw new UnsafeSvg(`The entity &${name}; is not allowed.`);
    const code = numeric[1] !== undefined ? parseInt(numeric[1], 16) : Number(numeric[2]);
    const character = code > 0x10ffff ? '' : String.fromCodePoint(code);
    if (character === '' || NOT_XML_CHAR.test(character)) {
      throw new UnsafeSvg('A character reference names no XML character.');
    }
    return character;
  });
}

/** A strict reader for the subset of XML a drawing needs. Throws on anything else. */
function parse(text: string): Element {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) {
    throw new UnsafeSvg('A diagram may not declare a DOCTYPE or entities.');
  }
  if (NOT_XML_CHAR.test(text)) {
    throw new UnsafeSvg('A diagram may not contain characters XML does not allow.');
  }
  const root: Element = { name: '#root', attributes: [], children: [] };
  const stack: Element[] = [root];
  let at = 0;
  let nodes = 0;

  const top = () => stack[stack.length - 1] ?? root;
  const until = (marker: string, from: number): number => {
    const end = text.indexOf(marker, from);
    if (end < 0) throw new UnsafeSvg('The diagram ends inside markup.');
    return end;
  };

  while (at < text.length) {
    if (!text.startsWith('<', at)) {
      const end = text.indexOf('<', at);
      const stop = end < 0 ? text.length : end;
      top().children.push(decode(text.slice(at, stop)));
      at = stop;
      continue;
    }
    if (text.startsWith('<!--', at)) {
      at = until('-->', at + 4) + 3;
      continue;
    }
    if (text.startsWith('<?', at)) {
      at = until('?>', at + 2) + 2;
      continue;
    }
    if (text.startsWith('<![CDATA[', at)) {
      const end = until(']]>', at + 9);
      top().children.push(text.slice(at + 9, end));
      at = end + 3;
      continue;
    }
    if (text.startsWith('<!', at)) {
      throw new UnsafeSvg('A diagram may not carry declarations.');
    }
    if (text.startsWith('</', at)) {
      const close = /^<\/([A-Za-z_][\w:.-]*)\s*>/.exec(text.slice(at, at + 300));
      const open = stack.pop();
      if (close === null || open === undefined || open === root || open.name !== close[1]) {
        throw new UnsafeSvg('The diagram closes an element it did not open.');
      }
      at += close[0].length;
      continue;
    }

    const name = /^<([A-Za-z_][\w:.-]*)/.exec(text.slice(at, at + 300));
    if (name?.[1] === undefined) throw new UnsafeSvg('The diagram has a malformed tag.');
    at += name[0].length;
    const element: Element = { name: name[1], attributes: [], children: [] };
    for (;;) {
      const space = /^\s*/.exec(text.slice(at, at + 1000))?.[0].length ?? 0;
      at += space;
      if (text.startsWith('/>', at)) {
        at += 2;
        top().children.push(element);
        break;
      }
      if (text.startsWith('>', at)) {
        at += 1;
        top().children.push(element);
        stack.push(element);
        if (stack.length > MAX_DEPTH) throw new UnsafeSvg('The diagram nests too deeply.');
        break;
      }
      const attribute = /^([A-Za-z_][\w:.-]*)\s*=\s*(["'])/.exec(text.slice(at, at + 300));
      if (attribute?.[1] === undefined || attribute[2] === undefined || space === 0) {
        throw new UnsafeSvg('The diagram has a malformed attribute.');
      }
      at += attribute[0].length;
      const end = until(attribute[2], at);
      const raw = text.slice(at, end);
      if (raw.includes('<')) throw new UnsafeSvg('An attribute value may not contain "<".');
      element.attributes.push([attribute[1], decode(raw)]);
      at = end + 1;
    }
    nodes += 1;
    if (nodes > MAX_NODES) throw new UnsafeSvg('The diagram has too many elements.');
  }

  if (stack.length !== 1) throw new UnsafeSvg('The diagram ends with an element still open.');
  const elements = root.children.filter((child): child is Element => typeof child !== 'string');
  const svg = elements[0];
  if (elements.length !== 1 || svg?.name !== 'svg') {
    throw new UnsafeSvg('A diagram must be exactly one <svg> element.');
  }
  return svg;
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', '&quot;');
}

/** The attribute as it may be published, or null to drop it. */
function keptAttribute(name: string, value: string): [string, string] | null {
  if (name === 'xlink:href') name = 'href';
  if (!ATTRIBUTES.has(name) && !DATA_ATTRIBUTE.test(name)) return null;
  if (/javascript:|data:|vbscript:/i.test(value.replaceAll(/\s/g, ''))) return null;
  if (name === 'href') return /^#[\w.:-]+$/.test(value) ? [name, value] : null;
  if (name === 'style') return safeCss(value) ? [name, value] : null;
  for (const match of value.matchAll(ANY_URL)) {
    if (!LOCAL_URL.test(match[0])) return null;
  }
  return [name, value];
}

function attribute(element: Element, name: string): string | undefined {
  return element.attributes.find(([key]) => key === name)?.[1];
}

/**
 * The `<use>` elements to drop: any whose target is missing or itself holds a `<use>`, so a
 * reference is never more than one level deep and the picture cannot grow exponentially.
 */
function unsafeUses(svg: Element): Set<Element> {
  const byId = new Map<string, Element>();
  const uses: Element[] = [];
  const visit = (element: Element): void => {
    const id = attribute(element, 'id');
    if (id !== undefined && !byId.has(id)) byId.set(id, element);
    if (element.name === 'use') uses.push(element);
    for (const child of element.children) if (typeof child !== 'string') visit(child);
  };
  visit(svg);
  if (uses.length > MAX_USE_ELEMENTS) {
    throw new UnsafeSvg('The diagram repeats too many elements.');
  }
  const holdsUse = (element: Element): boolean =>
    element.name === 'use' ||
    element.children.some((child) => typeof child !== 'string' && holdsUse(child));
  return new Set(
    uses.filter((use) => {
      const href = attribute(use, 'href') ?? attribute(use, 'xlink:href') ?? '';
      const target = href.startsWith('#') ? byId.get(href.slice(1)) : undefined;
      return target === undefined || holdsUse(target);
    }),
  );
}

function write(element: Element, out: string[], dropped: Set<Element>): void {
  if (UNWRAPPED.has(element.name)) {
    for (const child of element.children) {
      if (typeof child === 'string') out.push(escapeText(child));
      else write(child, out, dropped);
    }
    return;
  }
  if (!ELEMENTS.has(element.name) || dropped.has(element)) return;
  if (element.name === 'style') {
    const css = element.children.filter((child) => typeof child === 'string').join('');
    if (element.children.some((child) => typeof child !== 'string') || !safeCss(css)) return;
  }
  out.push(`<${element.name}`);
  // `xlink:href` becomes `href`, so a name can arrive twice; XML allows it once, the first wins.
  const written = new Set<string>();
  for (const [name, value] of element.attributes) {
    const kept = keptAttribute(name, value);
    if (kept === null || written.has(kept[0])) continue;
    written.add(kept[0]);
    out.push(` ${kept[0]}="${escapeAttribute(kept[1])}"`);
  }
  out.push('>');
  for (const child of element.children) {
    if (typeof child === 'string') out.push(escapeText(child));
    else write(child, out, dropped);
  }
  out.push(`</${element.name}>`);
}

function dimension(value: string | undefined): number | null {
  const number = value === undefined ? NaN : Number(value);
  return Number.isFinite(number) && number > 0 && number <= 100_000 ? Math.ceil(number) : null;
}

/**
 * Parses, filters and re-serialises an SVG. With `sourceSha256`, stamps the picture with the
 * source it was captured from; without, keeps the stamp the picture already carries.
 *
 * Throws {@link UnsafeSvg} when the input is too large, not well-formed, or not one `<svg>`.
 */
export function sanitizeSvg(text: string, sourceSha256?: string): SanitizedSvg {
  if (text.length > MAX_DIAGRAM_BYTES) throw new UnsafeSvg('The diagram is too large to publish.');
  const svg = parse(text.replace(/^\uFEFF/, ''));
  const read = (name: string) => svg.attributes.find(([key]) => key === name)?.[1];

  const box = (read('viewBox') ?? '').trim().split(/[\s,]+/);
  const width = dimension(box.length === 4 ? box[2] : read('width'));
  const height = dimension(box.length === 4 ? box[3] : read('height'));
  const stamped = sourceSha256 ?? read(SOURCE_HASH_ATTRIBUTE) ?? null;
  const hash = stamped !== null && SHA256.test(stamped) ? stamped : null;

  // The root's own size (often `width="100%"` with a max-width style) becomes the drawing's
  // intrinsic size, so an <img> has an aspect ratio and a natural width.
  const root: Element = {
    name: 'svg',
    attributes: [
      ...svg.attributes.filter(
        ([key]) => !['width', 'height', 'style', SOURCE_HASH_ATTRIBUTE].includes(key),
      ),
      ...(width !== null && height !== null
        ? ([
            ['width', String(width)],
            ['height', String(height)],
          ] as [string, string][])
        : []),
      ...(hash === null ? [] : ([[SOURCE_HASH_ATTRIBUTE, hash]] as [string, string][])),
    ],
    children: svg.children,
  };
  const out: string[] = [];
  write(root, out, unsafeUses(root));
  // Every attribute xmlns* was dropped by the allowlist; the one namespace is restated.
  const serialized = out.join('').replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
  if (serialized.length > MAX_DIAGRAM_BYTES) {
    throw new UnsafeSvg('The diagram is too large to publish.');
  }
  return { svg: serialized, width, height, sourceSha256: hash };
}
