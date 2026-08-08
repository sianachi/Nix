/**
 * The link graph, read out of a materialised document.
 *
 * This is the one place a document's *meaning* is turned into an edge, and it lives here rather
 * than in Core for the same reason validation does: an edge is a fact about a merged document,
 * and merging needs a CRDT runtime Core does not have. The service extracts; Core reads.
 *
 * Everything produced here is derived. Dropping every edge costs the backlinks panel until each
 * document is next snapshotted and costs nothing durable, because the update log the edges were
 * read from is untouched.
 */

/**
 * The largest plaintext handed to `to_tsvector`.
 *
 * Postgres refuses a text search input over one megabyte outright, and a document large enough
 * to reach that is one whose first half million characters are a more than adequate index. The
 * bound is here rather than in the SQL so the truncation is visible to anybody reading what gets
 * sent, and low enough that multi-byte characters cannot push the encoded form past the server's
 * limit.
 */
export const SEARCH_TEXT_CEILING = 500_000;

/**
 * A well-formed identifier, in the only shape Core mints.
 *
 * A `targetId` arrives from a browser inside a document, so it is client-controlled: nothing
 * stops somebody writing a reference node whose target is the word "banana". Sent to Postgres as
 * a `uuid` that fails to parse, and the whole snapshot write fails with it - a document that
 * would no longer save because of one malformed link. Filtering here is what keeps a bad
 * reference a bad reference rather than an outage for the document holding it.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The node kind a reference to another item takes in a document. */
const REFERENCE_NODE = 'reference';

/** The reference kind that points at an item, as opposed to at a person. */
const ITEM_KIND = 'item';

/**
 * Every item a materialised ProseMirror document refers to, and how often.
 *
 * **Counted, not listed.** A document that mentions another five times is one backlink, so the
 * caller gets one entry per target. The count comes free from the same walk and is the difference
 * between a passing mention and the subject of a paragraph when this is eventually ranked.
 *
 * **Item references only.** `@` can also produce a reference to a person, and a person is not
 * somewhere a backlinks panel can send you. Those are skipped rather than stored with a
 * discriminator, because a mention of a person needs a different surface and will want a table
 * shaped for it rather than a nullable column on this one.
 *
 * **Self-references are dropped.** A document that links to itself would otherwise appear in its
 * own backlinks panel, which reads as a bug however it got there.
 */
export function extractItemLinks(json: unknown, sourceItemId: string): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  walk(json, (node) => {
    if (node.type !== REFERENCE_NODE || node.attrs === null || typeof node.attrs !== 'object') {
      return;
    }

    const attrs = node.attrs as Record<string, unknown>;
    if (readString(attrs.kind) !== ITEM_KIND) {
      return;
    }

    const targetId = readString(attrs.targetId);
    if (targetId === null || !UUID.test(targetId) || targetId === sourceItemId) {
      return;
    }

    counts.set(targetId, (counts.get(targetId) ?? 0) + 1);
  });

  return counts;
}

/** The searchable text of a document, bounded to what the server will accept. */
export function boundSearchText(plaintext: string): string {
  return plaintext.length <= SEARCH_TEXT_CEILING
    ? plaintext
    : plaintext.slice(0, SEARCH_TEXT_CEILING);
}

/** As much of a node as this walk claims to know; everything else is passed over untouched. */
interface DocumentNode {
  readonly type?: unknown;
  readonly attrs?: unknown;
  readonly content?: unknown;
}

/**
 * Visits every node of a materialised document, depth first.
 *
 * Written against the JSON rather than the ProseMirror node, because the JSON is what the caller
 * already has: `materialize` produced it for the snapshot, and re-deriving a typed document to
 * walk it would parse the whole thing a second time on a path that runs on every snapshot.
 *
 * The node is handed to the visitor as it was found rather than copied into a narrower shape. On
 * a large document that is one fewer object allocated per node, on a path that already runs
 * inside the transaction a person is waiting on.
 *
 * Iterative rather than recursive. A document is user-supplied and nests as deeply as somebody
 * cares to nest it - lists inside quotes inside lists - and a recursive walk turns that into a
 * stack overflow that takes the process down with it rather than one refused document.
 */
function walk(root: unknown, visit: (node: DocumentNode) => void): void {
  const pending: unknown[] = [root];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== 'object') {
      continue;
    }

    if (Array.isArray(current)) {
      pushAll(pending, current as unknown[]);
      continue;
    }

    const node = current as DocumentNode;
    visit(node);

    if (Array.isArray(node.content)) {
      pushAll(pending, node.content as unknown[]);
    }
  }
}

/**
 * Appends every child to the queue, one at a time.
 *
 * A loop rather than `push(...children)`, because the spread passes each element as its own
 * argument: a node with a hundred thousand children - a pasted table, a long list - would be one
 * call with a hundred thousand arguments, which overflows the stack. The whole point of an
 * iterative walk is not to depend on stack depth, and a spread would have quietly put the
 * dependency back.
 */
function pushAll(queue: unknown[], children: readonly unknown[]): void {
  for (const child of children) {
    queue.push(child);
  }
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
