import { Listbox, useListbox, type ListboxOption } from '@nix/ui';
import { FileText } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { Editor } from '@tiptap/react';
import { z } from 'zod';

import { useAuth } from '../auth/auth-provider';

/**
 * The reference picker: `[[` and `@`, an item search, and a `reference` node.
 *
 * **One picker for both triggers.** They differ in what they offer, not in what they produce: `[[`
 * is items, `@` is items and people. The node is the same either way, which is why
 * `@nix/editor-schema` defines one - two would be two schema entries, two fixtures and two
 * migrations to say the same thing twice.
 *
 * **Focus never leaves the document, and the query is never held here.** The trigger and what has
 * been typed after it are read out of the document on every transaction, so the picker survives
 * everything a component-held query does not: clicking away and back, a colleague's edit arriving
 * through the CRDT and shifting every position, undo. It is also the only arrangement that works
 * at all - a field of its own would take the focus, and the next character typed would go into the
 * picker instead of into the note.
 *
 * The slash menu does hold its query in a field, which is why its removal arithmetic assumes the
 * caret has not moved. That is a real difference in robustness between the two, and this is the
 * shape the slash menu should eventually take.
 *
 * **The search is the server's, not the loaded tree's.** The sidebar fetches children per folder
 * on expansion, so a client-side filter can only see what somebody has already clicked open -
 * which for a picker means the item you are trying to link to is usually the one it cannot find.
 */

/** How far into a trigger somebody can type before it stops being a link and starts being prose. */
const MAX_QUERY = 64;

/** How long to wait after the last keystroke before asking the server. */
const DEBOUNCE_MS = 150;

/** The most candidates to offer. A picker is scanned, not read. */
const RESULT_LIMIT = 8;

/**
 * The shortest query sent to the server, matching `SearchItemsHandler.MinimumQueryLength`.
 *
 * Below three characters there is no trigram to look up and the server falls back to reading every
 * item the caller can reach. The picker opens on the trigger and offers a prompt until then.
 */
const MINIMUM_QUERY = 3;

const SearchSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      workspaceId: z.string(),
      type: z.string(),
      title: z.string().nullable(),
    }),
  ),
});

type SearchHit = z.infer<typeof SearchSchema>['results'][number];

/** One completed search, tagged with the query it answers. */
interface SearchAnswer {
  readonly query: string;
  readonly hits: readonly SearchHit[];
  readonly failed: boolean;
}

/** One empty array, so "no results" does not change identity on every render. */
const EMPTY_HITS: readonly SearchHit[] = [];

/** An open trigger: where its text starts, what has been typed into it, and which kind it is. */
export interface FoundTrigger {
  readonly start: number;
  readonly query: string;
  readonly kind: 'item' | 'principal';
}

/**
 * Finds an open `[[` or `@` in the text before the caret.
 *
 * A trigger only counts at the start of a word - after whitespace, or at the very start - so an
 * email address does not open a people picker and `a[[b` stays text. A newline or a closing
 * bracket ends it, and so does a query longer than anybody would type into a link: past that
 * ceiling this is somebody who wrote `[[` and carried on with a paragraph.
 *
 * Exported for its own tests: it is pure string handling, and the alternative is asserting it
 * through an editor, a document and a selection.
 */
export function findTrigger(text: string, truncated = false): FoundTrigger | null {
  const brackets = text.lastIndexOf('[[');
  const at = text.lastIndexOf('@');

  const start = Math.max(brackets, at);
  if (start < 0) {
    return null;
  }

  const isBrackets = start === brackets;

  // Position zero is the start of a word only when it really is the start of the block. When the
  // caller handed over a window cut out of a longer paragraph, the character before it is unknown -
  // and guessing "whitespace" would turn the middle of an email address into a people picker.
  const before = start === 0 ? (truncated ? undefined : ' ') : text[start - 1];
  if (before === undefined || !/\s/.test(before)) {
    return null;
  }

  const query = text.slice(start + (isBrackets ? 2 : 1));
  if (query.length > MAX_QUERY || /[\n\]]/.test(query)) {
    return null;
  }

  return { start, query, kind: isBrackets ? 'item' : 'principal' };
}

/** Where the picker sits, and what it is filtering. */
interface OpenTrigger extends FoundTrigger {
  /** Document positions of the trigger's text, so it can be replaced exactly. */
  readonly from: number;
  readonly to: number;
  /** Viewport coordinates of the caret. */
  readonly left: number;
  readonly top: number;
}

export function ReferenceMenu({ editor }: { readonly editor: Editor }): ReactNode {
  const { getAccessToken } = useAuth();
  const [trigger, setTrigger] = useState<OpenTrigger | null>(null);
  const [answer, setAnswer] = useState<SearchAnswer | null>(null);
  const [dismissed, setDismissed] = useState<number | null>(null);

  // Read from the document on every transaction, because the document is where the trigger lives.
  useEffect(() => {
    function readTrigger(): void {
      const { state } = editor;
      const { from, empty } = state.selection;

      if (!empty) {
        setTrigger(null);
        return;
      }

      // Only the tail of the block is read. This runs on every transaction - every local keystroke
      // and every remote update arriving through the CRDT - and at most `MAX_QUERY` plus the
      // trigger can ever matter, so reading a whole paragraph would allocate a fresh copy of it
      // per keystroke per collaborator to look at its last sixty characters.
      const at = state.doc.resolve(from);
      const window = Math.max(0, at.parentOffset - (MAX_QUERY + 2));
      const text = at.parent.textBetween(window, at.parentOffset, '\n', '\n');
      const found = findTrigger(text, window > 0);

      if (found === null) {
        setTrigger(null);
        return;
      }

      const start = from - (text.length - found.start);
      const coords = editor.view.coordsAtPos(from);

      setTrigger({
        ...found,
        from: start,
        to: from,
        left: coords.left,
        top: coords.bottom,
      });
    }

    // Closed when the editor loses the focus. `open` derives from the document's selection, which
    // survives a blur - so clicking into the sidebar with `[[` half-typed left the picker floating
    // on screen with its only keyboard handler bound to an element that no longer had focus.
    function onBlur(): void {
      setTrigger(null);
    }

    readTrigger();
    editor.on('transaction', readTrigger);
    editor.on('blur', onBlur);

    return () => {
      editor.off('transaction', readTrigger);
      editor.off('blur', onBlur);
    };
  }, [editor]);

  // Escape closes a trigger without unwriting it: the `[[` somebody typed is theirs, and deleting
  // it would be the editor editing. Reopening the same trigger by typing another character is
  // deliberate - the dismissal is of one position, not of the feature.
  const open = trigger !== null && trigger.from !== dismissed;
  const query = trigger?.query ?? '';

  // The answer carries the query it answers, and anything else is ignored. That is what keeps the
  // previous trigger's results off the screen while this one is still being debounced - and it is
  // why closing the picker sets no state at all: there is nothing to clear.
  const current = answer !== null && answer.query === query ? answer : null;
  const hits = current?.hits ?? EMPTY_HITS;
  const failed = current?.failed ?? false;

  useEffect(() => {
    if (!open) {
      return;
    }

    if (query.length < MINIMUM_QUERY) {
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const token = await getAccessToken();
          const response = await fetch(
            `/api/v1/search?q=${encodeURIComponent(query)}&limit=${String(RESULT_LIMIT)}`,
            {
              signal: controller.signal,
              headers: token === null ? {} : { authorization: `Bearer ${token}` },
            },
          );

          if (!response.ok) {
            throw new Error(`Search answered ${String(response.status)}.`);
          }

          setAnswer({
            query,
            hits: SearchSchema.parse(await response.json()).results,
            failed: false,
          });
        } catch (cause) {
          if (controller.signal.aborted) {
            return;
          }

          // Said out loud rather than shown as "no matches". A picker that reports an empty
          // workspace when the request failed sends somebody off to create a document they
          // already have.
          console.warn('The reference search failed.', cause);
          setAnswer({ query, hits: EMPTY_HITS, failed: true });
        }
      })();
    }, DEBOUNCE_MS);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [getAccessToken, open, query]);

  const options: readonly ListboxOption[] = hits.map((hit) => ({
    id: hit.id,
    label: hit.title ?? 'Untitled',
    icon: FileText,
  }));

  const listbox = useListbox(options, (_option, index) => {
    const hit = hits[index];
    if (hit === undefined || trigger === null) {
      return;
    }

    // The trigger's text and the node go in one chain, so the document never holds a state where
    // the `[[` has gone and the reference has not arrived - which through the CRDT would be an
    // update every other client applies.
    editor
      .chain()
      .focus()
      .deleteRange({ from: trigger.from, to: trigger.to })
      .insertContent([
        {
          type: 'reference',
          attrs: { kind: trigger.kind, targetId: hit.id, label: hit.title ?? 'Untitled' },
        },
        { type: 'text', text: ' ' },
      ])
      .run();
  });

  // The keys are taken off the editor's own element, because that is what holds the focus. Capture
  // phase, so the arrow keys move the highlight rather than the caret while the picker is open.
  useEffect(() => {
    if (!open) {
      return;
    }

    const dom = editor.view.dom;
    const dismissAt = trigger.from;

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        // The innermost open layer wins and stops the event, so Escape here does not also close
        // the pane behind it. See `command-palette.tsx` for the full convention.
        event.preventDefault();
        event.stopPropagation();
        setDismissed(dismissAt);
        return;
      }

      listbox.onKeyDown(event);
    }

    dom.addEventListener('keydown', onKeyDown, true);
    return () => {
      dom.removeEventListener('keydown', onKeyDown, true);
    };
  }, [editor, listbox, open, trigger]);

  // `aria-activedescendant` on the editor itself. It is a textbox with a listbox attached, which
  // is what the attribute is for; without it the highlight moves silently for anybody who cannot
  // see it.
  useEffect(() => {
    const dom = editor.view.dom;
    if (!open) {
      dom.removeAttribute('aria-activedescendant');
      dom.removeAttribute('aria-controls');
      return;
    }

    dom.setAttribute('aria-controls', listbox.id);
    if (listbox.activeOptionId === undefined) {
      dom.removeAttribute('aria-activedescendant');
    } else {
      dom.setAttribute('aria-activedescendant', listbox.activeOptionId);
    }

    return () => {
      dom.removeAttribute('aria-activedescendant');
      dom.removeAttribute('aria-controls');
    };
  }, [editor, listbox.activeOptionId, listbox.id, open]);

  if (!open) {
    return null;
  }

  return (
    <div
      // Positioned against the caret in viewport coordinates, so it follows the text rather than
      // the scroller - which the editor does under it.
      style={{ left: trigger.left, top: trigger.top }} // design-token-exempt: a caret's position is a runtime measurement, not a scale step.
      className="fixed z-20 mt-1 flex max-h-[280px] w-[320px] flex-col overflow-y-auto border border-divider bg-background shadow-md"
    >
      <Listbox
        label={trigger.kind === 'principal' ? 'Items and people to link to' : 'Items to link to'}
        options={options}
        controller={listbox}
        emptyMessage={
          failed
            ? 'Could not search just now. Check your connection and try again.'
            : query.length < MINIMUM_QUERY
              ? `Type ${String(MINIMUM_QUERY)} letters or more to find an item.`
              : current === null
                ? 'Searching…'
                : 'No item matches that.'
        }
      />
    </div>
  );
}
