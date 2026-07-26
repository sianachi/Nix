/**
 * One fixture per node and per mark, plus a document that uses every one of them.
 *
 * These are the contract between the two sides of the schema. The collaboration service's
 * tests parse the same fixture document this package round-trips, so a change to the node
 * set that only one side heard about fails on both.
 *
 * Written as plain JSON rather than built through the schema on purpose: a fixture built
 * from the schema can only ever agree with it, which tests nothing. These are what a
 * client actually sends.
 */

/** A block-level fixture, keyed by the node it exercises. */
export const NODE_FIXTURES: Readonly<Record<string, unknown>> = {
  paragraph: { type: 'paragraph', content: [{ type: 'text', text: 'A paragraph.' }] },

  heading: {
    type: 'heading',
    attrs: { level: 2 },
    content: [{ type: 'text', text: 'A heading' }],
  },

  hardBreak: {
    type: 'paragraph',
    content: [
      { type: 'text', text: 'Before' },
      { type: 'hardBreak' },
      { type: 'text', text: 'after' },
    ],
  },

  blockquote: {
    type: 'blockquote',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Quoted.' }] }],
  },

  codeBlock: {
    type: 'codeBlock',
    attrs: { language: 'typescript' },
    content: [{ type: 'text', text: 'const answer = 42;' }],
  },

  horizontalRule: { type: 'horizontalRule' },

  bulletList: {
    type: 'bulletList',
    content: [
      {
        type: 'listItem',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'First' }] }],
      },
      {
        // Nested, because a list that cannot nest is not the list anyone means.
        type: 'listItem',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Second' }] },
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Nested' }] }],
              },
            ],
          },
        ],
      },
    ],
  },

  orderedList: {
    type: 'orderedList',
    attrs: { start: 1, type: null },
    content: [
      {
        type: 'listItem',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Step one' }] }],
      },
    ],
  },

  taskList: {
    type: 'taskList',
    content: [
      {
        type: 'taskItem',
        attrs: { checked: true },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Done' }] }],
      },
      {
        type: 'taskItem',
        attrs: { checked: false },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Not done' }] }],
      },
    ],
  },

  callout: {
    type: 'callout',
    attrs: { tone: 'warning' },
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Mind the gap.' }] }],
  },

  image: {
    type: 'image',
    attrs: {
      src: 'https://example.test/diagram.png',
      alt: 'A diagram',
      title: null,
      width: null,
      height: null,
    },
  },

  table: {
    type: 'table',
    content: [
      {
        type: 'tableRow',
        content: [
          {
            type: 'tableHeader',
            attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Name' }] }],
          },
          {
            type: 'tableHeader',
            attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Value' }] }],
          },
        ],
      },
      {
        type: 'tableRow',
        content: [
          {
            type: 'tableCell',
            attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Answer' }] }],
          },
          {
            type: 'tableCell',
            attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '42' }] }],
          },
        ],
      },
    ],
  },
};

/** An inline fixture per mark, each a paragraph carrying exactly that mark. */
export const MARK_FIXTURES: Readonly<Record<string, unknown>> = {
  bold: {
    type: 'paragraph',
    content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'strong' }],
  },
  italic: {
    type: 'paragraph',
    content: [{ type: 'text', marks: [{ type: 'italic' }], text: 'emphasis' }],
  },
  underline: {
    type: 'paragraph',
    content: [{ type: 'text', marks: [{ type: 'underline' }], text: 'underlined' }],
  },
  strike: {
    type: 'paragraph',
    content: [{ type: 'text', marks: [{ type: 'strike' }], text: 'struck' }],
  },
  code: {
    type: 'paragraph',
    content: [{ type: 'text', marks: [{ type: 'code' }], text: 'inline()' }],
  },
  highlight: {
    type: 'paragraph',
    content: [{ type: 'text', marks: [{ type: 'highlight' }], text: 'highlighted' }],
  },
  link: {
    type: 'paragraph',
    content: [
      {
        type: 'text',
        marks: [
          {
            type: 'link',
            attrs: {
              href: 'https://example.test/page',
              target: '_blank',
              rel: 'noopener noreferrer nofollow',
              class: null,
              title: null,
            },
          },
        ],
        text: 'a link',
      },
    ],
  },
};

/**
 * One document using every node and every mark.
 *
 * The single artefact both sides check themselves against. If it parses here and in the
 * collaboration service, the two builds agree about what a document is.
 */
export const FIXTURE_DOCUMENT: unknown = {
  type: 'doc',
  content: [...Object.values(NODE_FIXTURES), ...Object.values(MARK_FIXTURES)],
};
