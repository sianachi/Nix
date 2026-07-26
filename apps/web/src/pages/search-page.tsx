import { useState, type ReactNode } from 'react';

import { useWorkspaceTree } from '../items/use-workspace-tree';

/**
 * The search screen, per Fig. Search of the design language.
 *
 * The design's omnibox, with its keyboard hints and its result count. One thing on it is a promise
 * this build cannot yet keep, and the copy says so: real search filters permissions *inside* the
 * query, so unreadable items are never counted. What runs here is a title match over the items the
 * tree already returned - which is permission-filtered by row-level security, but is not the
 * indexed search the design describes.
 */
export function SearchPage(): ReactNode {
  const tree = useWorkspaceTree();
  const [query, setQuery] = useState('');

  const results =
    query.trim().length === 0
      ? []
      : tree.items.filter((item) => item.title.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="border-b border-divider p-6">
        <input
          type="search"
          aria-label="Search items"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          placeholder="Search this workspace…"
          className="w-full border border-divider bg-background px-4 py-3 text-[15px] outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
        <div className="mt-2 flex items-center gap-4 text-[11px] text-foreground/60">
          <span>&uarr;&darr; navigate</span>
          <span>&crarr; open</span>
          <span>esc close</span>
          <span className="ml-auto">
            {query.trim().length === 0
              ? 'Title match only until the search index lands'
              : `${String(results.length)} result${results.length === 1 ? '' : 's'}`}
          </span>
        </div>
      </div>

      <div className="flex-1 p-6">
        {query.trim().length === 0 ? (
          <p className="text-[12px] text-foreground/60">
            Type to search. This build matches titles in the loaded tree; full text search with
            snippets arrives with the search index.
          </p>
        ) : results.length === 0 ? (
          <p className="text-[12px] text-foreground/60">Nothing matched.</p>
        ) : (
          <ul className="flex flex-col border border-divider">
            {results.map((item) => (
              <li key={item.id} className="border-b border-divider px-4 py-3 last:border-b-0">
                <p className="text-[13.5px]">{item.title || 'Untitled'}</p>
                <p className="text-[11px] text-foreground/60">{item.type}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
