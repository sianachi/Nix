import {
  readBoolean,
  readNumber,
  readString,
  visitProse,
  type LossReport,
  type NodeHandler,
  type NodeHandlers,
  type ProseNode,
} from '@nix/export';

import { createHash } from 'node:crypto';

import { escapeHtml, safeHref, slugify } from './escape.js';
import { highlightCode } from './highlight.js';

/**
 * A document body as HTML, through the shared `@nix/export` visitor.
 *
 * Every string from the body is escaped, every href passes {@link safeHref}, and nothing the
 * page cannot show is dropped silently: it becomes a visible notice where a reader would expect
 * it, and a loss entry in the build result.
 *
 * Body headings start at `h2`, because the page title is the page's `h1`.
 */

export interface ProseAsset {
  readonly url: string;
  readonly width: number | null;
  readonly height: number | null;
}

/** A published download: where it is, its file name, and what kind and size it is. */
export interface ProseDownload {
  readonly url: string;
  readonly name: string;
  /** For example `PDF, 84 KB`. */
  readonly label: string;
}

export interface ProseContext {
  /** A published page's path for an item, or null when the item is not on the site. */
  readonly pathOf: (itemId: string) => string | null;
  readonly titleOf: (itemId: string) => string | null;
  /** A published image for a file item, or null when it was not copied. */
  readonly asset: (fileItemId: string) => ProseAsset | null;
  /**
   * A captured Mermaid picture, or null unless it was captured from exactly this source (its
   * SHA-256), so an edited diagram never publishes a stale picture.
   */
  readonly diagram: (fileItemId: string, sourceSha256: string) => ProseAsset | null;
  /** A published download for a file item, or null when it was not copied. */
  readonly download: (fileItemId: string) => ProseDownload | null;
}

export interface Heading {
  readonly level: number;
  readonly id: string;
  readonly text: string;
}

export interface RenderedProse {
  readonly html: string;
  readonly headings: readonly Heading[];
  /** The body's words as plain text, for search and reading time. */
  readonly text: string;
  /**
   * The text an excerpt is cut from: every top-level block but headings and code, each block
   * apart, so a heading is never read as the start of the paragraph under it.
   */
  readonly summary: string;
}

/** The download link a file block or reference becomes. */
export function downloadLink(download: ProseDownload, text: string, className: string): string {
  return `<a class="${className}" href="${escapeHtml(download.url)}">${escapeHtml(text)}</a>`;
}

function summaryText(body: unknown): string {
  const content = (body as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((block: { type?: unknown } | null) => {
      const type = block?.type;
      return type !== 'heading' && type !== 'codeBlock' && type !== 'image';
    })
    .map((block) => plainText(block).replace(/\s+/g, ' ').trim())
    .filter((text) => text.length > 0)
    .join(' ');
}

const CALLOUT_LABELS: Readonly<Record<string, string>> = {
  note: 'Note',
  tip: 'Tip',
  warning: 'Warning',
  danger: 'Danger',
};

export function notice(text: string): string {
  return `<p class="nix-notice">${escapeHtml(text)}</p>`;
}

/** The text a node holds, without markup. */
export function plainText(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null) {
    return '';
  }
  const node = raw as { type?: unknown; text?: unknown; content?: unknown; attrs?: unknown };
  if (typeof node.text === 'string') {
    return node.text;
  }
  if (node.type === 'reference' && typeof node.attrs === 'object' && node.attrs !== null) {
    const label = (node.attrs as Record<string, unknown>).label;
    return typeof label === 'string' ? label : '';
  }
  if (!Array.isArray(node.content)) {
    return '';
  }
  const block = node.type !== 'paragraph' && node.type !== 'heading' && node.type !== 'text';
  return node.content.map(plainText).join(block ? '\n' : '');
}

function alignClass(node: ProseNode): string {
  const align = readString(node.attrs, 'textAlign');
  return align === 'center' || align === 'right' || align === 'justify'
    ? ` class="nix-align-${align}"`
    : '';
}

/** The diagram's own accessible title or title line, or a generic name. */
function diagramLabel(source: string): string {
  const named = /^\s*accTitle\s*:\s*(.+)$/m.exec(source) ?? /^\s*title\s*:?\s*(.+)$/m.exec(source);
  const name = named?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
  return name.length > 0 ? `Diagram: ${name.slice(0, 200)}` : 'Diagram';
}

function span(attr: string, value: number | null): string {
  return value !== null && value > 1 ? ` ${attr}="${String(Math.floor(value))}"` : '';
}

export function renderProse(
  body: unknown,
  itemId: string,
  report: LossReport,
  context: ProseContext,
): RenderedProse {
  const headings: Heading[] = [];
  const used = new Set<string>();

  const anchor = (text: string): string => {
    const base = slugify(text);
    let id = base;
    for (let suffix = 2; used.has(id); suffix += 1) {
      id = `${base}-${String(suffix)}`;
    }
    used.add(id);
    return id;
  };

  const block =
    (tag: string): NodeHandler<string> =>
    (_node, _ctx, children) =>
      `<${tag}>${children().join('')}</${tag}>`;

  const handlers: NodeHandlers<string> = {
    doc: (_node, _ctx, children) => children().join('\n'),
    paragraph: (node, _ctx, children) => {
      const inner = children().join('');
      return inner.length === 0 ? null : `<p${alignClass(node)}>${inner}</p>`;
    },
    text: (node, ctx) => {
      let out = escapeHtml(node.text ?? '');
      const has = (name: string) => node.marks.some((mark) => mark.type === name);
      if (has('code')) out = `<code>${out}</code>`;
      if (has('strike')) out = `<s>${out}</s>`;
      if (has('underline')) out = `<u>${out}</u>`;
      if (has('italic')) out = `<em>${out}</em>`;
      if (has('bold')) out = `<strong>${out}</strong>`;
      if (has('highlight')) out = `<mark>${out}</mark>`;
      if (has('textColor')) {
        ctx.loss.note('text-formatting-dropped', 'Text colour is not published; the text is.');
      }
      if (has('comment')) {
        ctx.loss.note('comment-dropped', 'Comments stay in the workspace and are not published.');
      }
      const link = node.marks.find((mark) => mark.type === 'link');
      if (link !== undefined) {
        const href = safeHref(readString(link.attrs, 'href'));
        if (href === null) {
          ctx.loss.note(
            'reference-flattened',
            'A link with an address that cannot be published was kept as text.',
          );
        } else {
          const external = /^(https?|mailto):/i.test(href);
          out = `<a href="${escapeHtml(href)}"${external ? ' rel="noopener noreferrer"' : ''}>${out}</a>`;
        }
      }
      return out;
    },
    hardBreak: () => '<br>',
    heading: (node, _ctx, children) => {
      const level = Math.min(3, Math.max(1, readNumber(node.attrs, 'level') ?? 1)) + 1;
      const text = plainText({ type: 'heading', content: node.content });
      const id = anchor(text);
      headings.push({ level, id, text });
      return `<h${String(level)} id="${id}"${alignClass(node)}>${children().join('')}<a class="nix-anchor" href="#${id}" aria-label="Link to ${escapeHtml(text)}">#</a></h${String(level)}>`;
    },
    blockquote: block('blockquote'),
    codeBlock: (node, ctx) => {
      const language = readString(node.attrs, 'language');
      const code = plainText({ type: 'codeBlock', content: node.content });
      const label = language === null ? '' : ` data-language="${escapeHtml(language)}"`;
      if (language?.trim().toLowerCase() === 'mermaid') {
        const fileItemId = readString(node.attrs, 'renderFileId');
        const picture =
          fileItemId === null
            ? null
            : context.diagram(fileItemId, createHash('sha256').update(code).digest('hex'));
        if (picture !== null) {
          const size =
            picture.width !== null && picture.height !== null
              ? ` width="${String(picture.width)}" height="${String(picture.height)}"`
              : '';
          return `<figure class="nix-figure nix-diagram"><img src="${escapeHtml(picture.url)}" alt="${escapeHtml(diagramLabel(code))}"${size} loading="lazy" decoding="async"></figure><details class="nix-details nix-diagram-source"><summary>Diagram source</summary><pre class="nix-code"${label} tabindex="0"><code>${escapeHtml(code)}</code></pre></details>`;
        }
        ctx.loss.note(
          'image-not-embedded',
          fileItemId === null
            ? 'A Mermaid diagram has no captured picture yet, so its source was published instead.'
            : 'A Mermaid diagram changed after its picture was captured, or the picture is not available, so its source was published instead.',
        );
        return `${notice('This diagram is shown as its source.')}<pre class="nix-code"${label} tabindex="0"><code>${escapeHtml(code)}</code></pre>`;
      }
      return `<pre class="nix-code"${label} tabindex="0"><code class="hljs">${highlightCode(code, language)}</code></pre>`;
    },
    horizontalRule: () => '<hr>',
    pageBreak: () => null,
    callout: (node, _ctx, children) => {
      const tone = readString(node.attrs, 'tone') ?? 'note';
      const label = CALLOUT_LABELS[tone] ?? 'Note';
      const name = CALLOUT_LABELS[tone] === undefined ? 'note' : tone;
      return `<aside class="nix-callout nix-callout-${name}" aria-label="${label}"><p class="nix-callout-label">${label}</p>${children().join('')}</aside>`;
    },
    image: (node, ctx) => {
      const alt = escapeHtml(readString(node.attrs, 'alt') ?? '');
      const fileItemId = readString(node.attrs, 'fileItemId');
      const asset = fileItemId === null ? null : context.asset(fileItemId);
      if (asset !== null) {
        const size =
          asset.width !== null && asset.height !== null
            ? ` width="${String(asset.width)}" height="${String(asset.height)}"`
            : '';
        return `<figure class="nix-figure"><img src="${escapeHtml(asset.url)}" alt="${alt}"${size} loading="lazy" decoding="async"></figure>`;
      }
      const src = safeHref(readString(node.attrs, 'src'));
      if (fileItemId === null && src !== null && /^https?:/i.test(src)) {
        // Decision 1.8: the site serves only its own images, so an outside picture is a link.
        ctx.loss.note(
          'image-not-embedded',
          'An image stored at another address was published as a link.',
        );
        return `<p class="nix-notice"><a href="${escapeHtml(src)}" rel="noopener noreferrer">${alt.length > 0 ? alt : 'View image'}</a></p>`;
      }
      ctx.loss.note('image-not-embedded', 'An image could not be published.');
      return notice('An image is not available on this page.');
    },
    bulletList: block('ul'),
    orderedList: (node, _ctx, children) => {
      const start = readNumber(node.attrs, 'start');
      return `<ol${start !== null && start !== 1 ? ` start="${String(Math.floor(start))}"` : ''}>${children().join('')}</ol>`;
    },
    listItem: block('li'),
    taskList: (_node, _ctx, children) => `<ul class="nix-tasks">${children().join('')}</ul>`,
    taskItem: (node, _ctx, children) => {
      const checked = readBoolean(node.attrs, 'checked');
      return `<li class="nix-task${checked ? ' nix-task-done' : ''}"><span class="nix-task-box" role="img" aria-label="${checked ? 'Done' : 'Not done'}"></span><div>${children().join('')}</div></li>`;
    },
    table: (_node, _ctx, children) =>
      `<div class="nix-table" role="region" aria-label="Table" tabindex="0"><table><tbody>${children().join('')}</tbody></table></div>`,
    tableRow: block('tr'),
    tableHeader: (node, _ctx, children) =>
      `<th${span('colspan', readNumber(node.attrs, 'colspan'))}${span('rowspan', readNumber(node.attrs, 'rowspan'))}>${children().join('')}</th>`,
    tableCell: (node, _ctx, children) =>
      `<td${span('colspan', readNumber(node.attrs, 'colspan'))}${span('rowspan', readNumber(node.attrs, 'rowspan'))}>${children().join('')}</td>`,
    columnBlock: (_node, _ctx, children) => `<div class="nix-columns">${children().join('')}</div>`,
    column: (_node, _ctx, children) => `<div class="nix-column">${children().join('')}</div>`,
    details: (_node, _ctx, children) =>
      `<details class="nix-details">${children().join('')}</details>`,
    detailsSummary: (_node, _ctx, children) => `<summary>${children().join('')}</summary>`,
    detailsContent: (_node, _ctx, children) => `<div>${children().join('')}</div>`,
    reference: (node, ctx) => {
      const targetId = readString(node.attrs, 'targetId');
      const kind = readString(node.attrs, 'kind') ?? 'item';
      const path = kind === 'item' && targetId !== null ? context.pathOf(targetId) : null;
      const label =
        readString(node.attrs, 'label') ??
        (targetId === null ? null : context.titleOf(targetId)) ??
        'a page';
      if (path !== null) {
        return `<a class="nix-ref" href="${escapeHtml(path)}">${escapeHtml(label)}</a>`;
      }
      const file = kind === 'item' && targetId !== null ? context.download(targetId) : null;
      if (file !== null) {
        return downloadLink(file, readString(node.attrs, 'label') ?? file.name, 'nix-ref');
      }
      if (kind === 'item') {
        ctx.loss.note(
          'reference-flattened',
          'A link to a page that is not published was kept as its name.',
        );
      }
      return `<span class="nix-ref-text">${escapeHtml(label)}</span>`;
    },
    itemBlock: (node, ctx) => {
      const targetId = readString(node.attrs, 'targetId');
      const path = targetId === null ? null : context.pathOf(targetId);
      const title = targetId === null ? null : context.titleOf(targetId);
      if (path !== null) {
        ctx.loss.note(
          'reference-flattened',
          'A linked section was published as a link to its page.',
        );
        return `<p class="nix-item-link"><a href="${escapeHtml(path)}">${escapeHtml(title ?? 'Linked page')}</a></p>`;
      }
      const file = targetId === null ? null : context.download(targetId);
      if (file !== null) {
        return `<p class="nix-file">${downloadLink(file, file.name, 'nix-file-link')}<span class="nix-file-meta">${escapeHtml(file.label)}</span></p>`;
      }
      ctx.loss.note(
        'reference-flattened',
        'A linked section from a page that is not published was left out.',
      );
      return notice('A linked section is not published.');
    },
  };

  const html = visitProse(body, handlers, { itemId, report }) ?? '';
  return {
    html,
    headings,
    text: plainText(body).replace(/\s+/g, ' ').trim(),
    summary: summaryText(body),
  };
}
