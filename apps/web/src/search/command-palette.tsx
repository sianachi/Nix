import { Icon, Input, Listbox, Text, useListbox, type ListboxOption } from '@nix/ui';
import { search, type SearchHit } from '@nix/api-client';
import { FileText, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { useApiClient } from '../api/api-client-provider';
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

/**
 * The shortest query sent to the server, matching `SearchItemsHandler.MinimumQueryLength`.
 *
 * Below three characters there is no trigram to look up, so the server would read every item in
 * every workspace the caller can reach and filter it - measured at nearly four times the cost of a
 * real query, growing with the workspace rather than with the number of matches. Commands are still
 * filtered locally at any length, because that list is five entries in memory.
 */
const MINIMUM_QUERY = 3;

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly commands: readonly PaletteCommand[];
  readonly onSelectItem: (itemId: string) => void;
  readonly onClose: () => void;
}

export function CommandPalette(props: CommandPaletteProps): ReactNode {
  const { open, commands, onSelectItem, onClose } = props;
  const client = useApiClient();
  const [query, setQuery] = useState('');
  const [answer, setAnswer] = useState<SearchAnswer | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // What had the focus when the palette opened, so it can be given back. Without this, closing
  // drops focus to the body and the next Tab starts at the skip link - which for somebody who hit
  // Cmd-K mid-sentence and changed their mind means losing their place in the document. `<Dialog>`
  // makes the same argument at length for the same reason.
  const returnFocusTo = useRef<HTMLElement | null>(null);

  // Reset on the way out rather than in an effect on the way in: a setState inside an effect body
  // cascades a second render for something the close already knew, and reopening has to start
  // fresh rather than showing the last search's results as though they were current.
  const close = useCallback((): void => {
    setQuery('');
    setAnswer(null);
    onClose();

    // After `onClose`, so the palette has been asked to unmount before focus moves back.
    returnFocusTo.current?.focus();
    returnFocusTo.current = null;
  }, [onClose]);

  const needle = query.trim();

  useEffect(() => {
    if (!open) {
      return;
    }

    returnFocusTo.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open || needle.length < MINIMUM_QUERY) {
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const parsed = await client.query(search.searchItems(needle, RESULT_LIMIT), {
            signal: controller.signal,
          });
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
  }, [client, needle, open]);

  const current = answer !== null && answer.query === needle ? answer : null;
  const hits = current?.hits ?? EMPTY_HITS;
  const matched = filterCommands(commands, query);

  // In flight, and said out loud regardless of how many options happen to be showing. Carried by
  // `emptyMessage` alone, this was invisible whenever a command matched: type "n", the item results
  // for the previous query vanish because they answer a different needle, and nothing explains why.
  const searching = needle.length >= MINIMUM_QUERY && current === null;

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
            aria-expanded={listbox.expanded}
            aria-autocomplete="list"
            autoComplete="off"
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
                : needle.length < MINIMUM_QUERY
                  ? `Type ${String(MINIMUM_QUERY)} letters or more to search items.`
                  : searching
                    ? 'Searching…'
                    : `Nothing matches “${needle}”.`
          }
          className="max-h-[50vh] overflow-y-auto"
        />

        {/*
          One line under the list, carrying whichever of these applies. `role="status"` because all
          three arrive without the person doing anything, and the mounted-empty region is what makes
          the announcement reliable.
        */}
        <div role="status" className="empty:hidden">
          {searching ? (
            <Text
              as="p"
              variant="caption"
              tone="muted"
              className="border-t border-divider px-4 py-2"
            >
              Searching…
            </Text>
          ) : current?.truncated === true ? (
            <Text
              as="p"
              variant="caption"
              tone="muted"
              className="border-t border-divider px-4 py-2"
            >
              Showing the first {hits.length} items. Type more to narrow it down.
            </Text>
          ) : current !== null && hits.length === 0 && matched.length > 0 ? (
            // The palette found a command but no document, and the reason may be timing rather than
            // absence: text inside documents becomes searchable when the document is saved. Said
            // here for the same reason the backlinks panel says it.
            <Text
              as="p"
              variant="caption"
              tone="muted"
              className="border-t border-divider px-4 py-2"
            >
              No items matched. Text inside a document becomes searchable once it has been saved.
            </Text>
          ) : null}
        </div>
      </div>
    </div>
  );
}
