/**
 * Direction 2: Markdown parsed back into a ProseMirror document body, as plain JSON.
 *
 * **Built on `prosemirror-markdown`'s `MarkdownParser` against the real `nixSchema`, then gated
 * through `parseDocument`.** markdown-it tokenises, the parser maps its tokens onto Nix's own node
 * names, and a short post-pass rebuilds the two custom constructs `documentToMarkdown` emits with a
 * plain-Markdown spelling - a `nix://` link back into a reference node, a `[!tone]` blockquote back
 * into a callout. Anything the round trip cannot rebuild degrades to the nearest standard node
 * rather than failing, and the final document is always validated: an input that would produce a
 * body the schema rejects returns `{ ok: false }` with the reason, never a silently broken doc.
 *
 * The constructs `documentToMarkdown` flattens on the way out - a column layout, a table, a task
 * list's checkboxes - do not come back as themselves here, by construction: they were written as
 * their nearest Markdown form and that is what parses. Those are the declared losses, reported on
 * the outbound side.
 */

import MarkdownIt from 'markdown-it';
import { MarkdownParser, type ParseSpec } from 'prosemirror-markdown';
import { nixSchema, parseDocument, REFERENCE_KINDS } from '@nix/editor-schema';

export type FromMarkdownResult =
  | { readonly ok: true; readonly doc: unknown }
  | { readonly ok: false; readonly reason: string };

/** The minimal shape of a ProseMirror node in its JSON form, for the post-pass. */
interface JsonNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

// GFM-ish: strikethrough is on, HTML is off so a stray tag is escaped text rather than an injected
// node the schema has no home for. Tables are deliberately NOT enabled: `documentToMarkdown`
// flattens a table to a pipe grid and declares the loss, so a pipe grid coming back in should read
// as the plain text it now is rather than re-tokenise into a `table_open` this parser has no node
// for. The details block and standalone images are pre-processed below before this ever runs.
const tokenizer = MarkdownIt('commonmark', { html: false }).enable(['strikethrough']);

// A block image survives Markdown's round trip only with help: `documentToMarkdown` writes a
// block-level image as `![alt](src)` on its own line, but re-parsing puts an image inline, where
// Nix's block-level image node cannot live, so the parser drops it. These two markers carry a
// standalone image out of inline context and back into a block image node in the post-pass.
const IMAGE_SENTINEL = /^\s*nix-image:(\d+)\s*$/;
const STANDALONE_IMAGE = /^!\[([^\]]*)]\(([^)\n]+)\)$/gm;

/**
 * markdown-it token names mapped onto Nix's node and mark names.
 *
 * Nix's schema uses camelCase node names where prosemirror-markdown's default parser uses
 * snake_case, so this is a fresh map rather than a tweak of the default - a shared key would map to
 * a node the schema does not have.
 */
const tokens: Record<string, ParseSpec> = {
  blockquote: { block: 'blockquote' },
  paragraph: { block: 'paragraph' },
  list_item: { block: 'listItem' },
  bullet_list: { block: 'bulletList' },
  ordered_list: {
    block: 'orderedList',
    getAttrs: (token) => ({ start: Number(token.attrGet('start') ?? 1) || 1 }),
  },
  heading: {
    block: 'heading',
    getAttrs: (token) => ({ level: Number(token.tag.slice(1)) || 1 }),
  },
  code_block: { block: 'codeBlock', noCloseToken: true },
  fence: {
    block: 'codeBlock',
    getAttrs: (token) => ({ language: token.info.trim() || null }),
    noCloseToken: true,
  },
  hr: { node: 'horizontalRule' },
  image: {
    node: 'image',
    getAttrs: (token) => {
      // markdown-it puts the alt text in the token's inline children; fall back to the attribute
      // only when there is no child text, which a nullish coalesce cannot express (an empty string
      // is a real value to it).
      const fromChildren = token.children?.map((child) => child.content).join('') ?? '';
      return {
        src: token.attrGet('src') ?? '',
        alt: fromChildren.length > 0 ? fromChildren : (token.attrGet('alt') ?? ''),
        title: token.attrGet('title'),
      };
    },
  },
  hardbreak: { node: 'hardBreak' },
  em: { mark: 'italic' },
  strong: { mark: 'bold' },
  s: { mark: 'strike' },
  link: {
    mark: 'link',
    getAttrs: (token) => ({ href: token.attrGet('href') ?? '' }),
  },
  code_inline: { mark: 'code', noCloseToken: true },
};

const parser = new MarkdownParser(nixSchema, tokenizer, tokens);

/** `nix://<kind>/<targetId>` - the spelling `documentToMarkdown` gives a reference. */
const NIX_LINK = /^nix:\/\/([a-z]+)\/(.+)$/;

/** A blockquote's first line marker, `[!tone]` - the spelling it gives a callout. */
const CALLOUT_MARKER = /^\[!([a-z]+)]$/;

function isKnownReferenceKind(kind: string): boolean {
  return (REFERENCE_KINDS as readonly string[]).includes(kind);
}

/**
 * Rewrite `documentToMarkdown`'s own details spelling into plain blocks before parsing.
 *
 * A `<details>` block has no node in a Markdown parser, and HTML is off. Rather than let the tags
 * survive as escaped text, the summary becomes a bold line and the wrapper is dropped, so the toggle
 * degrades to its readable content. The structure is not rebuilt - a details node does not round
 * trip - which is the one custom node this bridge cannot carry both ways.
 */
function stripDetails(markdown: string): string {
  return markdown
    .replace(/<details(?: data-toggle-level="\d+")?>\s*/g, '')
    .replace(/<summary>([\s\S]*?)<\/summary>/g, (_match, summary: string) => `**${summary.trim()}**\n`)
    .replace(/\s*<\/details>/g, '');
}

/** Depth-first rewrite of the parsed JSON: link -> reference, `[!tone]` blockquote -> callout,
 *  image sentinel paragraph -> block image. */
function rebuildCustomNodes(node: JsonNode, images: readonly { src: string; alt: string }[]): JsonNode {
  const reference = asReference(node);
  if (reference !== null) {
    return reference;
  }

  const image = asImage(node, images);
  if (image !== null) {
    return image;
  }

  const rewrittenChildren = node.content?.map((child) => rebuildCustomNodes(child, images));
  const withChildren: JsonNode =
    rewrittenChildren === undefined ? node : { ...node, content: rewrittenChildren };

  return asCallout(withChildren) ?? withChildren;
}

/** A paragraph holding only an image sentinel becomes the block image it stood in for. */
function asImage(node: JsonNode, images: readonly { src: string; alt: string }[]): JsonNode | null {
  if (node.type !== 'paragraph' || node.content?.length !== 1) {
    return null;
  }
  const only = node.content[0];
  const match = only?.type === 'text' ? IMAGE_SENTINEL.exec(only.text ?? '') : null;
  const index = match === null ? null : Number(match[1]);
  const image = index === null ? undefined : images[index];
  if (image === undefined) {
    return null;
  }
  return { type: 'image', attrs: { src: image.src, alt: image.alt, title: null } };
}

/** A text node carrying a single `nix://` link becomes a reference inline node. */
function asReference(node: JsonNode): JsonNode | null {
  if (node.type !== 'text' || node.marks === undefined) {
    return null;
  }

  const link = node.marks.find((mark) => mark.type === 'link');
  const href = typeof link?.attrs?.href === 'string' ? link.attrs.href : null;
  const match = href === null ? null : NIX_LINK.exec(href);
  const kindRaw = match?.[1];
  const targetId = match?.[2];
  if (kindRaw === undefined || targetId === undefined) {
    return null;
  }

  const kind = isKnownReferenceKind(kindRaw) ? kindRaw : 'item';
  return {
    type: 'reference',
    attrs: { kind, targetId, label: node.text ?? '' },
  };
}

/** A blockquote whose first paragraph is a `[!tone]` marker becomes a callout. */
function asCallout(node: JsonNode): JsonNode | null {
  if (node.type !== 'blockquote' || node.content === undefined || node.content.length === 0) {
    return null;
  }

  const first = node.content[0];
  if (first === undefined) {
    return null;
  }
  const firstInline = first.type === 'paragraph' && first.content?.length === 1 ? first.content[0] : undefined;
  const markerText = firstInline?.type === 'text' ? (firstInline.text ?? '') : null;
  const tone = markerText === null ? undefined : CALLOUT_MARKER.exec(markerText)?.[1];
  if (tone === undefined) {
    return null;
  }

  const rest = node.content.slice(1);
  return {
    type: 'callout',
    attrs: { tone },
    content: rest.length > 0 ? rest : [{ type: 'paragraph' }],
  };
}

/**
 * Parse Markdown into a validated ProseMirror document body.
 *
 * @param markdown The Markdown source.
 * @returns The document JSON, or the reason it could not be produced.
 */
export function markdownToDocument(markdown: string): FromMarkdownResult {
  // Lift standalone images out to sentinels first, so re-parsing does not drop them inline.
  const images: { src: string; alt: string }[] = [];
  const sentinelled = stripDetails(markdown).replace(STANDALONE_IMAGE, (_match, alt: string, src: string) => {
    const index = images.push({ src, alt }) - 1;
    return ` nix-image:${String(index)} `;
  });

  let json: JsonNode;
  try {
    // MarkdownParser.parse returns a document node or throws; it never returns null.
    json = parser.parse(sentinelled).toJSON() as JsonNode;
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'The Markdown could not be parsed.' };
  }

  const rebuilt = rebuildCustomNodes(json, images);

  // The schema is the boundary, not the parser: a document that tokenised cleanly can still be a
  // shape the schema refuses (an empty doc, a mis-nested node), and that is a failure to report
  // rather than to hand on. parseDocument is the same gate the collaboration service applies.
  const parsed = parseDocument(rebuilt);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.error };
  }

  return { ok: true, doc: rebuilt };
}
