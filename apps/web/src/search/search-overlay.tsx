import { Icon, Input, Tag } from '@nix/ui';
import { FileText, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { TreeItem } from '../items/use-workspace-tree';

/**
 * Search, as an affordance rather than a destination.
 *
 * It opens over whatever is on screen and closes back onto it, because searching is something you
 * do *while* reading a document, not instead of reading one. Sending someone to a search page
 * loses their place and makes returning a navigation problem they did not ask to have.
 *
 * **It is honest about its reach.** In this phase it matches the titles the tree has already
 * loaded - nothing more - and the panel says so. Indexed, permission-filtered, full-text search
 * over every item in the workspace replaces the implementation behind this same control later; the
 * control, the shortcut and the muscle memory do not change. Claiming to search everything now
 * would make the eventual upgrade look like a regression when results suddenly appear that were
 * always there.
 */

export interface SearchOverlayProps {
  readonly open: boolean;
  readonly items: readonly TreeItem[];
  readonly onSelect: (itemId: string) => void;
  readonly onClose: () => void;
  /** Whether the tree has finished loading, which is what bounds the reach of a match. */
  readonly loaded: boolean;
}

const MAX_RESULTS = 20;

export function SearchOverlay(props: SearchOverlayProps): ReactNode {
  const { open, items, onSelect, onClose, loaded } = props;
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset on the way out rather than in an effect on the way in: a setState inside an effect body
  // cascades a second render for something the close already knew, and reopening has to start
  // fresh rather than showing the last search's results as though they were current.
  const close = useCallback((): void => {
    setQuery('');
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) {
      return;
    }

    inputRef.current?.focus();

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        close();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [close, open]);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) {
      return [];
    }

    return items.filter((item) => item.title.toLowerCase().includes(needle)).slice(0, MAX_RESULTS);
  }, [items, query]);

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
        aria-label="Search"
        className="relative w-full max-w-[680px] rounded-lg bg-background shadow-lg"
      >
        {/* Sized like the thing somebody came here to do. It was a form field in a row of
            chrome; at this size it is the surface itself, which is what a command palette is.
            The rule below it only appears once there is something to separate it from. */}
        <div
          className={[
            'flex items-center gap-3 px-5',
            query.trim().length === 0 ? '' : 'border-b border-divider',
          ].join(' ')}
        >
          <Icon icon={Search} size="md" />
          <Input
            ref={inputRef}
            tone="plain"
            aria-label="Search items"
            placeholder="Search notes by title"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            className="h-[var(--control-lg)] text-lg"
          />
        </div>

        <div className="max-h-[50vh] overflow-y-auto">
          {query.trim().length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted">
              Type to search the notes in this workspace.
            </p>
          ) : results.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted">
              Nothing matches &ldquo;{query.trim()}&rdquo;.
            </p>
          ) : (
            <ul>
              {results.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(item.id);
                      close();
                    }}
                    className="flex w-full items-center gap-2 border-b border-divider px-4 py-2 text-left text-base hover:bg-accent/10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
                  >
                    <Icon icon={FileText} size="sm" />
                    <span className="truncate">{item.title || 'Untitled'}</span>
                    <Tag tone="muted" className="ml-auto">
                      {item.type}
                    </Tag>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Said out loud rather than implied, because the difference matters the moment a note
            exists that this cannot find. */}
        <p className="border-t border-divider px-4 py-2 text-xs text-muted">
          {loaded
            ? 'Matches titles of the notes loaded in this workspace. Full-text search over every item arrives with the search index.'
            : 'Still loading this workspace; results will be incomplete until it finishes.'}
        </p>
      </div>
    </div>
  );
}
