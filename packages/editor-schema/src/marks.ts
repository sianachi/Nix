import { Mark, mergeAttributes } from '@tiptap/core';

/**
 * The colours text may be given.
 *
 * **Names, never values.** A picker that wrote a literal colour into a document body would
 * hard-code it in the most durable place this product has: a stored document outlives every
 * stylesheet, so the value would be fixed forever, wrong on one of the two grounds from the
 * day it was typed and unfixable without a content migration. A name resolves through the
 * design tokens at render, which is what makes the same document legible on both.
 *
 * **Three, not six.** The token sheet is deliberately mono - one steel accent, no red and no
 * amber (ADR-0011) - so semantic names like `success` and `danger` have no hue to resolve to.
 * Offering them would mean a picker with six entries and three renderings, which is a control
 * that lies: the document would store a distinction the product never honours, permanently, in
 * the place that is hardest to take back. Callouts get away with four tones because a
 * container can vary its border weight; an inline span has no border to vary. Widening this
 * set is an ADR adding a semantic ramp to the tokens, not a class string.
 *
 * A closed set for the same reason `CALLOUT_TONES` is closed, and with the same fallback: a
 * value this build does not know renders as `default` rather than failing to parse. Text in
 * the wrong colour is readable; a document that will not open is not.
 *
 * **The fallback is applied at render, not at parse.** A document arriving from a newer build
 * with a colour this one has never heard of keeps that value in the CRDT and passes it on
 * untouched; only the drawing falls back. Normalising on the way in would mean an older client
 * silently rewriting a newer client's document every time it opened one.
 */
export const TEXT_COLORS = ['default', 'accent', 'muted'] as const;

export type TextColor = (typeof TEXT_COLORS)[number];

const DEFAULT_COLOR: TextColor = 'default';

function readColor(value: unknown): TextColor | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  return TEXT_COLORS.includes(value as TextColor) ? (value as TextColor) : DEFAULT_COLOR;
}

/**
 * Colour, foreground and background together in one mark.
 *
 * One mark rather than two because they are set from one control and are almost always set
 * together; two marks would mean two entries in the schema, two fixtures, and a document
 * where removing the foreground silently leaves an orphan background behind.
 *
 * Deliberately **not** `@tiptap/extension-text-style` with its `Color` and
 * `BackgroundColor`: those store an arbitrary CSS colour in a `style` attribute, which is
 * exactly the hard-coded value the token rule exists to prevent.
 */
export const TextColorMark = Mark.create({
  name: 'textColor',

  addAttributes() {
    return {
      text: {
        default: null,
        parseHTML: (element) => readColor(element.getAttribute('data-text-color')),
        renderHTML: (attributes) => {
          const color = readColor(attributes.text);
          return color === null ? {} : { 'data-text-color': color };
        },
      },

      background: {
        default: null,
        parseHTML: (element) => readColor(element.getAttribute('data-background-color')),
        renderHTML: (attributes) => {
          const color = readColor(attributes.background);
          return color === null ? {} : { 'data-background-color': color };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-text-color]' }, { tag: 'span[data-background-color]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes), 0];
  },
});

/**
 * The range a comment thread is anchored to.
 *
 * **The mark renders; the stored anchor finds.** A thread lives in Postgres, where it can be
 * queried, resolved and counted, and it carries an encoded Yjs relative position so the
 * server can place it without loading the document. But a relative position cannot follow
 * heavy concurrent editing the way a mark does - a mark is merged by the CRDT like any other
 * and stays on the words it was put on. So both exist, and each does the job the other
 * cannot: the mark is authoritative for where the highlight is drawn, the anchor is the
 * fallback when the mark was lost to a paste and the sort key for the sidebar.
 *
 * `inclusive: false` so typing at the edge of a commented range does not silently extend
 * somebody else's thread over the new text.
 *
 * `excludes: ''` so overlapping threads are legal. Two comments on overlapping ranges is a
 * normal thing for two people to do, and a schema that refused it would drop one of them.
 */
export const CommentMark = Mark.create({
  name: 'comment',

  inclusive: false,

  excludes: '',

  addAttributes() {
    return {
      threadId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-comment-thread'),
        renderHTML: (attributes) =>
          typeof attributes.threadId === 'string' && attributes.threadId.length > 0
            ? { 'data-comment-thread': attributes.threadId }
            : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-comment-thread]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes), 0];
  },
});
