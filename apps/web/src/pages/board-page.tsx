import { type ReactNode } from 'react';

import { useWorkspaceTree } from '../items/use-workspace-tree';

/**
 * The board screen, per Fig. Board of the design language.
 *
 * Free columns over a cross-folder query, as the design has it. The columns are the workspace's
 * task states; the cards are items. Until property schemas land there is no status property to
 * group by, so every item sits in Backlog and the screen says so rather than inventing a
 * distribution - a board that looked populated would be describing data that does not exist.
 */
const COLUMNS = ['Backlog', 'In progress', 'In review', 'Done'] as const;

export function BoardPage(): ReactNode {
  const tree = useWorkspaceTree();

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-divider px-6 py-3">
        <span className="font-heading text-[15px] uppercase tracking-[0.06em]">Board</span>
        <span className="text-[11px] text-foreground/60">
          source: this workspace &middot; unreadable items are omitted entirely
        </span>
      </div>

      {tree.status === 'loading' ? (
        <p className="px-6 py-4 text-[12px] text-foreground/60">Loading the board…</p>
      ) : tree.status === 'error' ? (
        <p role="alert" className="px-6 py-4 text-[12px] text-foreground/70">
          {tree.error}
        </p>
      ) : (
        <div className="flex flex-1 gap-4 overflow-x-auto p-6">
          {COLUMNS.map((column) => (
            <section
              key={column}
              aria-label={column}
              className="flex w-[260px] shrink-0 flex-col border border-divider"
            >
              <h2 className="border-b border-divider bg-neutral-100 px-3 py-2 text-[11px] uppercase tracking-[0.08em] text-foreground/70">
                {column}
              </h2>

              <div className="flex flex-col gap-2 p-2">
                {column === 'Backlog' && tree.items.length > 0 ? (
                  tree.items.map((item) => (
                    <article key={item.id} className="border border-divider bg-background p-3">
                      <p className="text-[13px]">{item.title || 'Untitled'}</p>
                      <p className="mt-1 text-[11px] text-foreground/60">{item.type}</p>
                    </article>
                  ))
                ) : (
                  <p className="px-1 py-2 text-[11px] text-foreground/60">
                    {column === 'Backlog'
                      ? 'No items yet.'
                      : 'Grouping needs a status property, which arrives with property schemas.'}
                  </p>
                )}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
