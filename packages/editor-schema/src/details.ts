import { Details as BaseDetails, DetailsContent, DetailsSummary } from '@tiptap/extension-details';

/**
 * The heading levels a toggle may present as, plus "not a heading at all".
 *
 * The same three levels `Heading` is configured with, because a toggle that could present
 * as an h4 would be the only h4 in the product.
 */
export const TOGGLE_LEVELS = [1, 2, 3] as const;

export type ToggleLevel = (typeof TOGGLE_LEVELS)[number];

function readLevel(value: unknown): ToggleLevel | null {
  const level = Number(value);
  return TOGGLE_LEVELS.includes(level as ToggleLevel) ? (level as ToggleLevel) : null;
}

/**
 * A collapsible section: a summary anybody can click, and content that folds away.
 *
 * **Named for the nodes, not for the feature.** The product calls this a toggle; the nodes in
 * every stored document are `details`, `detailsSummary` and `detailsContent`, and so are the
 * entries in the version table, the fixtures and the style map. One vocabulary, so grepping
 * either word finds all of it - an alias here would have meant a maintainer searching "toggle"
 * finding the extension and missing the other four places. The one place the product's word
 * survives is `toggleLevel`, because that attribute is named for what an author chose.
 *
 * **`persist` is left at its default of `false`, which is a decision and not an oversight.**
 * With it on, the open state becomes an attribute in the document - so your collapsing a
 * section would collapse it for everyone reading it, in real time, through the CRDT. A
 * collapse is a reading posture, not content. The cost is that the state is per-session and
 * every toggle opens closed; that is the right trade and it is the one to revisit if anybody
 * asks why a toggle they left open is shut again.
 *
 * The practical consequence for the schema is that `open` is not in it, so a toggle costs
 * three node types and no attributes that have to be migrated later.
 *
 * **`toggleLevel` is what makes a toggle heading a toggle heading.** Notion has two controls
 * here - a toggle list and a toggle heading - and they differ only in how the summary is
 * drawn. One node with a level attribute, defaulting to null for the plain toggle, says that
 * in the schema rather than duplicating three node types to say it twice.
 */
export const Details = BaseDetails.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      toggleLevel: {
        default: null,
        parseHTML: (element: HTMLElement) => readLevel(element.getAttribute('data-toggle-level')),
        renderHTML: (attributes: Record<string, unknown>) => {
          const level = readLevel(attributes.toggleLevel);
          return level === null ? {} : { 'data-toggle-level': String(level) };
        },
      },
    };
  },
  // Stated rather than inherited. `persist: false` is already the package's default, but the
  // default is theirs to change and this is a decision about what lives in the CRDT - so it
  // is written down where the reasoning above can be read next to it.
}).configure({ persist: false });

export { DetailsContent, DetailsSummary };
