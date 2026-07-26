/**
 * Pulls the extensions' command types into anything that imports this package.
 *
 * TipTap declares its commands by augmenting `@tiptap/core` from each extension package. An
 * application that calls `editor.chain().toggleBold()` therefore needs those augmentations in its
 * compilation - and would otherwise have to depend on all twenty extension packages itself, purely
 * for types it never imports by name.
 *
 * `export type {}` loads a module for its declarations and exports nothing, so the augmentations
 * arrive and the runtime bundle is untouched. The dependency stays declared in exactly one place,
 * which is also the place that decides which extensions exist.
 */

export type {} from '@tiptap/extension-blockquote';
export type {} from '@tiptap/extension-bold';
export type {} from '@tiptap/extension-code';
export type {} from '@tiptap/extension-code-block';
export type {} from '@tiptap/extension-hard-break';
export type {} from '@tiptap/extension-heading';
export type {} from '@tiptap/extension-highlight';
export type {} from '@tiptap/extension-horizontal-rule';
export type {} from '@tiptap/extension-image';
export type {} from '@tiptap/extension-italic';
export type {} from '@tiptap/extension-link';
export type {} from '@tiptap/extension-list';
export type {} from '@tiptap/extension-paragraph';
export type {} from '@tiptap/extension-strike';
export type {} from '@tiptap/extension-table';
export type {} from '@tiptap/extension-underline';
