import { Icon, Input, Listbox, useListbox, type ListboxOption } from '@nix/ui';
import { FileText, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';

import { useAuth } from '../auth/auth-provider';
import { filterCommands, type PaletteCommand } from './commands';

/**
 * Search, jump and run a command, from anywhere.
 *
 * It opens over whatever is on screen and closes back onto it, because searching is something you
 * do *while* reading a document rather than instead of reading one. Sending somebody to a search
 * page loses their place and makes returning a navigation problem they did not ask to have.
 *
 * **What replaced what.** The surface, the shortcut and the muscle memory are the ones the search
 * overlay established; what changed is underneath. It used to filter the titles the workspace tree
 * had already loaded, and the panel said so - which was honest but not useful, because the tree
 * fetches children per folder on expansion and the item somebody is looking for is nearly always
 * in a folder they have not opened. It now asks the server, which searches titles and document
 * text across every workspace the caller may read, filtered inside the query.
 *
 * **Commands and items in one list, not two.** They are ordered - commands first, then items -
 * rather than separated into panes, so one sequence of arrow keys walks the whole answer and Enter
 * always commits whatever is highlighted.
 */

const SearchSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      workspaceId: z.string(),
      type: z.string(),
      title: z.string().nullable(),
    }),
  ),
  truncated: z.boolean(),
});

type SearchHit = z.infer<typeof SearchSchema>['results'][number];

/** One completed search, tagged with the query it answers, so a stale one is never shown. */
interface SearchAnswer {
  readonly query: string;
  readonly hits: readonly SearchHit[];
  readonly truncated: boolean;
  readonly failed: boolean;
}

const EMPTY_HITS: readonly SearchHit[] = [];

/** How long to wait after the last keystroke before asking the server. */
const DEBOUNCE_MS = 150;

/** The most items to offer. A palette is scanned, not read. */
const RESULT_LIMIT = 20;

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly commands: readonly PaletteCommand[];
  readonly onSelectItem: (itemId: string) => void;
  readonly onClose: () => void;
}

export function CommandPalette(props: CommandPaletteProps): ReactNode {
  const { open, commands, onSelectItem, onClose } = props;
  const { getAccessToken } = useAuth();
  const [query, setQuery] = useState('');
  const [answer, setAnswer] = useState<SearchAnswer | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset on the way out rather than in an effect on the way in: a setState inside an effect body
  // cascades a second render for something the close already knew, and reopening has to start
  // fresh rather than showing the last search's results as though they were current.
  const close = useCallback((): void => {
    setQuery('');
    setAnswer(null);
    onClose();
  }, [onClose]);

  const needle = query.trim();

  useEffect(() => {
    if (!open) {
      return;
    }

    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open || needle.length === 0) {
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const token = await getAccessToken();
          const response = await fetch(
            `/api/v1/search?q=${encodeURIComponent(needle)}&limit=${String(RESULT_LIMIT)}`,
            {
              signal: controller.signal,
              headers: token === null ? {} : { authorization: `Bearer ${token}` },
            },
          );

          if (!response.ok) {
            throw new Error(`Search answered ${String(response.status)}.`);
          }

          const parsed = SearchSchema.parse(await response.json());
          setAnswer({
            query: needle,
            hits: parsed.results,
            truncated: parsed.truncated,
            failed: false,
          });
        } catch (cause) {
          if (controller.signal.aborted) {
            return;
          }

          // Reported as a failure rather than as "nothing matches". A palette that says a
          // workspace is empty when the request failed sends somebody off to recreate a document
          // they already have.
          console.warn('The search failed.', cause);
          setAnswer({ query: needle, hits: EMPTY_HITS, truncated: false, failed: true });
        }
      })();
    }, DEBOUNCE_MS);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [getAccessToken, needle, open]);

  const current = answer !== null && answer.query === needle ? answer : null;
  const hits = current?.hits ?? EMPTY_HITS;
  const matched = filterCommands(commands, query);

  // Commands first, then items, in one list. The index into it is what the keyboard walks, so the
  // two kinds are told apart on the way out rather than on the way in.
  const options: readonly ListboxOption[] = [
    ...matched.map((command) => ({
      id: `command:${command.id}`,
      label: command.label,
      hint: command.hint,
      icon: command.icon,
      group: 'Commands',
    })),
    ...hits.map((hit) => ({
      id: `item:${hit.id}`,
      label: hit.title ?? 'Untitled',
      icon: FileText,
      group: 'Items',
    })),
  ];

  const listbox = useListbox(options, (_option, index) => {
    if (index < matched.length) {
      matched[index]?.run();
      close();
      return;
    }

    const hit = hits[index - matched.length];
    if (hit !== undefined) {
      onSelectItem(hit.id);
      close();
    }
  });

  if (!open) {
    return null;
  }

  return (
    // The scrim is a fixed dark step rather than an ink wash, and it is the one place in this file
    // that does not follow the ground. A wash of `--color-foreground` inverts with the theme, which
    // for a hover tint is the point and for a scrim is the defect: on the dark ground it turned the
    // page behind this panel into a milky haze instead of dimming it. `<Dialog>` settled the same
    // question the same way.
    <div className="fixed inset-0 z-30 flex items-start justify-center bg-neutral-900/40 px-4 pt-[12vh]">
      {/* The backdrop closes on click, which is what everybody tries first. It is not the only
          way out: Escape works, and the close is also reachable by keyboard from the field. */}
      <button
        type="button"
        aria-label="Close search"
        onClick={close}
        className="absolute inset-0 cursor-default"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search and commands"
        className="relative flex w-full max-w-[680px] flex-col rounded-lg bg-background shadow-lg"
      >
        <div
          className={[
            'flex items-center gap-3 px-5',
            options.length === 0 ? '' : 'border-b border-divider',
          ].join(' ')}
        >
          <Icon icon={Search} size="md" />
          <Input
            ref={inputRef}
            tone="plain"
            role="combobox"
            aria-expanded
            aria-controls={listbox.id}
            aria-activedescendant={listbox.activeOptionId}
            aria-label="Search items or run a command"
            placeholder="Search or run a command"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                // The innermost layer's Escape wins - see `workspace-sidebar.tsx`'s `CreateMenu`
                // for the full reasoning. This is reachable while the off-canvas drawer is open,
                // since the header stays interactive by design, so without stopping here Escape
                // would close both in one keystroke.
                event.stopPropagation();
                close();
                return;
              }

              listbox.onKeyDown(event);
            }}
            className="h-[var(--control-lg)] text-lg"
          />
        </div>

        <Listbox
          label="Commands and items"
          options={options}
          controller={listbox}
          emptyMessage={
            current?.failed === true
              ? 'The search could not be run just now. Check your connection and try again.'
              : needle.length === 0
                ? 'Type to search this workspace, or to find a command.'
                : current === null
                  ? 'Searching…'
                  : `Nothing matches “${needle}”.`
          }
          className="max-h-[50vh] overflow-y-auto"
        />

        {current?.truncated === true ? (
          <p className="border-t border-divider px-4 py-2 text-xs text-muted">
            Showing the first {hits.length} items. Type more to narrow it down.
          </p>
        ) : null}
      </div>
    </div>
  );
}
