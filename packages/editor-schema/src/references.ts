import { Node, mergeAttributes } from '@tiptap/core';

/**
 * What a reference points at.
 *
 * One node for both because the difference is entirely in resolution - who is asked for the
 * label, and what happens on a click - and nothing in the document's shape. Two nodes would
 * be two schema entries, two fixtures and two migrations to say the same thing twice.
 *
 * The trigger a person types is not this: `[[` and `@` both produce an item reference, and
 * `@` additionally offers people. That is a menu's concern, in the editor.
 */
export const REFERENCE_KINDS = ['item', 'principal'] as const;

export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

const DEFAULT_KIND: ReferenceKind = 'item';

function readKind(value: unknown): ReferenceKind {
  return REFERENCE_KINDS.includes(value as ReferenceKind) ? (value as ReferenceKind) : DEFAULT_KIND;
}

/** The stored label, or a stand-in - never an empty string, which would render as nothing. */
function readLabel(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : 'Untitled';
}

/**
 * A pointer to an item or a person, inline.
 *
 * **The target is an identifier, never a title.** A reference that stored the title would
 * be a copy that goes stale the moment somebody renames the thing, and renaming is the
 * single most common edit an item receives. `label` is a cache for rendering before
 * resolution returns and for degrading honestly when it never does - it is what a reader
 * sees while a fetch is in flight, and what they see for a target they may not read.
 *
 * **An atom, and inline.** A reference has no editable interior: putting a cursor inside
 * one and typing would produce a reference whose text disagrees with its target, which is
 * the failure the identifier exists to prevent.
 *
 * **A reader who may not open the target must not be shown its title.** The stored label is a
 * cache of a title, and a cache of a title the reader has no permission on is a leak wearing a
 * fallback's clothes. Resolution, when it lands, has to answer three ways - resolved, still
 * loading, and not yours to see - and the third renders a stub, never this label.
 */
export const Reference = Node.create({
  name: 'reference',

  group: 'inline',

  inline: true,

  atom: true,

  addAttributes() {
    return {
      kind: {
        default: DEFAULT_KIND,
        parseHTML: (element) => readKind(element.getAttribute('data-kind')),
        renderHTML: (attributes) => ({ 'data-kind': readKind(attributes.kind) }),
      },

      targetId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-target-id'),
        renderHTML: (attributes) =>
          typeof attributes.targetId === 'string' && attributes.targetId.length > 0
            ? { 'data-target-id': attributes.targetId }
            : {},
      },

      /** What the target was called when the reference was made. A cache, never the truth. */
      label: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-label'),
        renderHTML: (attributes) =>
          typeof attributes.label === 'string' && attributes.label.length > 0
            ? { 'data-label': attributes.label }
            : {},
      },
    };
  },

  /**
   * What a reference contributes as plain text.
   *
   * Both hooks, because two callers ask the question two ways: `renderText` is TipTap's own,
   * and `leafText` on the ProseMirror spec is what `Node.textBetween` consults - which is the
   * one the collaboration service reaches when it materialises a document for the search
   * index. Without it a reference is a hole in the searchable text of every document carrying
   * one, and a note whose only mention of a topic is a link to it is unfindable by that topic.
   */
  renderText({ node }) {
    return readLabel(node.attrs.label);
  },

  extendNodeSchema() {
    return { leafText: (node: { attrs: { label?: unknown } }) => readLabel(node.attrs.label) };
  },

  parseHTML() {
    return [{ tag: 'span[data-reference]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    // The label is rendered as the element's own text, not left to a node view. An atom with
    // no content and no view is an empty box - which is what this was, and what made the
    // stored label unreachable to a reader. Drawn here, an unresolved reference shows the
    // title it had when it was made, which is the honest thing to show while a fetch is in
    // flight and the only thing there is to show if none is ever made.
    return [
      'span',
      mergeAttributes(HTMLAttributes, { 'data-reference': '' }),
      readLabel(node.attrs.label),
    ];
  },
});
