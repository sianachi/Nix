import { Node, mergeAttributes } from '@tiptap/core';

/**
 * The tones a callout can carry.
 *
 * A fixed set rather than a free string, because the tone selects a colour from the
 * design tokens and an unknown value would have no colour to select. Documents from a
 * newer build fall back to `note` rather than failing to parse - a callout with the
 * wrong colour is readable; a document that will not open is not.
 */
export const CALLOUT_TONES = ['note', 'tip', 'warning', 'danger'] as const;

export type CalloutTone = (typeof CALLOUT_TONES)[number];

const DEFAULT_TONE: CalloutTone = 'note';

function readTone(value: unknown): CalloutTone {
  return CALLOUT_TONES.includes(value as CalloutTone) ? (value as CalloutTone) : DEFAULT_TONE;
}

/**
 * An admonition: a titled container holding ordinary blocks.
 *
 * The only node in the set Nix defines itself, and it is defined here rather than
 * assembled from a paragraph with a class because the container is what carries meaning.
 * A reader can put anything inside one - lists, code, another paragraph - and the tone
 * travels with the container rather than with each child.
 *
 * `content` is `block+`, not `paragraph+`: a warning that cannot contain a list is a
 * worse warning, and nesting is what a Notion-style callout is for.
 */
export const Callout = Node.create({
  name: 'callout',

  group: 'block',

  content: 'block+',

  defining: true,

  addAttributes() {
    return {
      tone: {
        default: DEFAULT_TONE,
        parseHTML: (element) => readTone(element.getAttribute('data-tone')),
        renderHTML: (attributes) => ({ 'data-tone': readTone(attributes.tone) }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'aside[data-callout]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['aside', mergeAttributes(HTMLAttributes, { 'data-callout': '' }), 0];
  },
});
