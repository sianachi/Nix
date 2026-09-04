import { Node, mergeAttributes } from '@tiptap/core';

/** Presentation never changes the target item's place in the tree. */
export const ItemBlock = Node.create({
  name: 'itemBlock',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      targetId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-target-id'),
        renderHTML: (attrs) => ({
          'data-target-id': typeof attrs.targetId === 'string' ? attrs.targetId : '',
        }),
      },
      presentation: {
        default: 'attachment',
        parseHTML: (element) => element.getAttribute('data-presentation'),
        renderHTML: (attrs) => ({
          'data-presentation':
            typeof attrs.presentation === 'string' ? attrs.presentation : 'attachment',
        }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-item-block]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-item-block': '' }), 'Linked item'];
  },
});

export const PageBreak = Node.create({
  name: 'pageBreak',
  group: 'pageBoundary',
  atom: true,
  selectable: true,
  parseHTML() {
    return [{ tag: 'div[data-page-break]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-page-break': '' }), 'Page break'];
  },
});
