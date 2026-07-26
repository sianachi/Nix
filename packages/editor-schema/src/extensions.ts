import type { Extensions } from '@tiptap/core';
import { Blockquote } from '@tiptap/extension-blockquote';
import { Bold } from '@tiptap/extension-bold';
import { Code } from '@tiptap/extension-code';
import { CodeBlock } from '@tiptap/extension-code-block';
import { Document } from '@tiptap/extension-document';
import { HardBreak } from '@tiptap/extension-hard-break';
import { Heading } from '@tiptap/extension-heading';
import { Highlight } from '@tiptap/extension-highlight';
import { HorizontalRule } from '@tiptap/extension-horizontal-rule';
import { Image } from '@tiptap/extension-image';
import { Italic } from '@tiptap/extension-italic';
import { Link } from '@tiptap/extension-link';
import { BulletList, ListItem, OrderedList, TaskItem, TaskList } from '@tiptap/extension-list';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Strike } from '@tiptap/extension-strike';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { Text } from '@tiptap/extension-text';
import { Underline } from '@tiptap/extension-underline';

import { Callout } from './callout.js';

/**
 * The document's block and mark set.
 *
 * **Schema only.** Nothing here installs editing behaviour - no gap cursor, no drop
 * cursor, no keymaps, no history. Those belong to the editor and are added by
 * `apps/web`; the collaboration service builds this same list in Node to check that an
 * update still produces a document that parses, and has no use for any of them.
 *
 * **The set is close to complete on purpose.** `SCHEMA_VERSION` is what stored documents
 * are validated against, so a block added later is a version bump every stored document
 * has to be migrated past. Tables and callouts are here now rather than as a follow-on
 * for exactly that reason - they are the two that a thin first cut always omits and
 * always needs.
 */
export const nixExtensions: Extensions = [
  // Structure.
  Document,
  Paragraph,
  Text,
  HardBreak,

  // Blocks.
  Heading.configure({ levels: [1, 2, 3] }),
  Blockquote,
  CodeBlock,
  HorizontalRule,
  Callout,
  Image,

  // Lists. Nesting is allowed; a list item holds blocks, so a bullet can carry a
  // paragraph and a nested list rather than text alone.
  BulletList,
  OrderedList,
  ListItem,
  TaskList,
  TaskItem.configure({ nested: true }),

  // Tables, via prosemirror-tables. The one block where a naive schema produces a
  // structure nobody can edit sanely - column sizing, cell selection, merged cells -
  // and the ProseMirror table module is the mature answer. Yjs merges its cell nodes
  // like any others, so collaboration needs nothing special here.
  Table.configure({ resizable: true }),
  TableRow,
  TableHeader,
  TableCell,

  // Marks.
  Bold,
  Italic,
  Underline,
  Strike,
  Code,
  Highlight.configure({ multicolor: false }),
  Link.configure({ openOnClick: false, autolink: true }),
];
