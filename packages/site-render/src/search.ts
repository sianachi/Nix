/**
 * The client-side search index: each published page's title and words, as token postings.
 *
 * Built only from pages the site actually rendered, so the public index can never name a page
 * that is not published. Tokens are NFKD-folded, lowercased runs of letters and digits, two
 * characters or longer. The index is capped at {@link SEARCH_INDEX_LIMIT}: past it, page bodies are
 * dropped (titles stay) and the caller reports a partial index.
 */

export const SEARCH_INDEX_LIMIT = 2 * 1024 * 1024;

export interface SearchDocument {
  readonly path: string;
  readonly title: string;
  readonly text: string;
}

export interface SearchIndex {
  readonly docs: readonly { readonly p: string; readonly t: string }[];
  readonly terms: Readonly<Record<string, readonly number[]>>;
}

export function tokenize(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && token.length <= 40);
}

function build(documents: readonly SearchDocument[], withBodies: boolean): SearchIndex {
  const sorted = [...documents].sort((a, b) => a.path.localeCompare(b.path));
  const postings = new Map<string, Set<number>>();
  sorted.forEach((doc, index) => {
    for (const token of tokenize(withBodies ? `${doc.title} ${doc.text}` : doc.title)) {
      let set = postings.get(token);
      if (set === undefined) {
        set = new Set();
        postings.set(token, set);
      }
      set.add(index);
    }
  });
  const terms: Record<string, number[]> = {};
  for (const token of [...postings.keys()].sort()) {
    terms[token] = [...(postings.get(token) ?? [])].sort((a, b) => a - b);
  }
  return { docs: sorted.map((doc) => ({ p: doc.path, t: doc.title })), terms };
}

export function buildSearchIndex(documents: readonly SearchDocument[]): {
  json: string;
  partial: boolean;
} {
  const full = JSON.stringify(build(documents, true));
  if (Buffer.byteLength(full) <= SEARCH_INDEX_LIMIT) {
    return { json: full, partial: false };
  }
  return { json: JSON.stringify(build(documents, false)), partial: true };
}
