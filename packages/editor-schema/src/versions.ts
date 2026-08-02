import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

/**
 * The version every document starts at: the node and mark set as first shipped.
 *
 * Named because it appears in three places that mean the same thing and would otherwise each
 * be a bare `1` - the floor of {@link requiredSchemaVersion}, and the answer the canvas and
 * sheet strategies give because their content carries no ProseMirror nodes at all.
 */
export const BASE_SCHEMA_VERSION = 1;

/**
 * The schema version each node first became legal in.
 *
 * **Only entries above {@link BASE_SCHEMA_VERSION} appear.** A name absent from this table has
 * been legal since the beginning, which is the overwhelming majority and would be noise to
 * list. `SCHEMA_VERSION` says what this build can read; these two tables say what a given
 * *document* needs, which is the finer-grained question and the one that keeps a document's
 * pin honest.
 *
 * **Why this exists at all.** `content_doc.schema_version` is a promise: "no build older than
 * this is needed to open me." Nothing enforced that promise before - a new build could write a
 * brand-new node into a document still pinned to 1, and the next older client to open it would
 * be told the document was safe and then fail to parse it. The pin was true only by scheduling,
 * which is to say true until the first time it mattered. Walking a merged document against
 * these tables is what makes it true by construction.
 *
 * Kept here rather than in the collaboration service because it is a fact about the schema, and
 * the schema is defined exactly once (`extensions.ts`). A second copy in Node is the drift this
 * package exists to prevent.
 */
export const NODE_MIN_VERSION: Readonly<Record<string, number>> = Object.freeze({});

/** The schema version each mark first became legal in. Only entries above 1 appear. */
export const MARK_MIN_VERSION: Readonly<Record<string, number>> = Object.freeze({});

/** The two tables {@link requiredSchemaVersion} consults, together. */
export interface MinimumVersions {
  readonly nodes: Readonly<Record<string, number>>;
  readonly marks: Readonly<Record<string, number>>;
}

/** The shipped tables. The default for every production caller. */
export const MIN_VERSIONS: MinimumVersions = Object.freeze({
  nodes: NODE_MIN_VERSION,
  marks: MARK_MIN_VERSION,
});

/**
 * The lowest schema version a build must speak to open this document.
 *
 * Returns {@link BASE_SCHEMA_VERSION} for a document using nothing newer, which is every
 * document until the first bump.
 *
 * @param tables which minimums to consult. Defaulted to the shipped ones, and a parameter only
 * so the rule itself is testable: with both shipped tables empty, a version that always
 * returned 1 would pass every assertion that could otherwise be written about this function.
 *
 * **Written as index loops with no closures, deliberately.** This runs on every accepted update
 * on both write paths, and `for (const mark of node.marks)` allocates an array iterator per
 * node that V8 does not elide here - the callback reaches it through `nodesBetween`'s
 * megamorphic dispatch. Measured on an 18,001-node document: 14,701 bytes per call as an
 * iterator loop against 318 bytes as an index loop, and 19% slower with it. That is churn paid
 * on every keystroke batch for a function that, today, always returns 1.
 */
export function requiredSchemaVersion(
  document: ProseMirrorNode,
  tables: MinimumVersions = MIN_VERSIONS,
): number {
  let required = BASE_SCHEMA_VERSION;

  const visit = (node: ProseMirrorNode): void => {
    const nodeMinimum = tables.nodes[node.type.name];
    if (nodeMinimum !== undefined && nodeMinimum > required) {
      required = nodeMinimum;
    }

    const { marks } = node;
    // Justification: `prefer-for-of` asks for exactly the array iterator this loop exists to
    // avoid. Measured on an 18,001-node document, the for-of form allocates 14,701 bytes per
    // call against 318 and runs 19% slower - V8 does not elide the iterator here, because this
    // callback is reached through `nodesBetween`'s megamorphic dispatch. This runs on every
    // accepted update on both write paths.
    // eslint-disable-next-line @typescript-eslint/prefer-for-of
    for (let index = 0; index < marks.length; index += 1) {
      const mark = marks[index];
      if (mark === undefined) {
        continue;
      }
      const markMinimum = tables.marks[mark.type.name];
      if (markMinimum !== undefined && markMinimum > required) {
        required = markMinimum;
      }
    }
  };

  // The root first: `descendants` does not visit the node it is called on, so a `doc` whose own
  // type were ever versioned would otherwise be missed entirely.
  visit(document);
  document.descendants((node) => {
    visit(node);
    return true;
  });

  return required;
}
