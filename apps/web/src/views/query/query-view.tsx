import { Button, Text, cn, focusRing } from '@nix/ui';
import type { ReactNode } from 'react';

import {
  EmptyPanel,
  ErrorPanel,
  LoadingPanel,
  PartialNotice,
} from '../../components/states/status-panels';
import { readPropertyText } from '../core/container-model';
import type { ViewRendererProps } from '../core/view-kinds';
import { useQueryResults } from './use-query-results';

/**
 * The query view: a smart list's matches, run server-side, drawn as rows that say where they live.
 *
 * The second kind whose data is not the container's children - its rows come from
 * `GET /items/{id}/query`, which compiles the view's stored filters over every container the
 * reader may see. `container.children` is deliberately ignored, and so is `useViewChrome`,
 * whose filter/sort/empty branches are statements about children this view does not draw; the
 * five states are answered here instead, from the run's own honesty fields.
 *
 * Server-ordered, no client sort: the rows were cut by a limit in the statement's order, and a
 * client re-sort of a truncated list would claim an order the full set does not have.
 */
export function QueryView(props: ViewRendererProps): ReactNode {
  const { container, view, onOpen } = props;

  // The itemId this view runs against is the smart list itself - the container's own id, not its
  // children. Every child the container may incidentally hold stays untouched by this view.
  const run = useQueryResults(container.itemId ?? '', view.id);

  if (run.status === 'loading') {
    return <LoadingPanel label="this smart list" />;
  }

  if (run.status === 'error' || run.results === null) {
    return (
      <ErrorPanel
        title="This smart list could not be run"
        detail={run.error ?? 'The query could not be read.'}
        action={
          <Button
            variant="secondary"
            onClick={() => {
              void run.reload();
            }}
          >
            Try again
          </Button>
        }
      />
    );
  }

  const { results } = run;

  if (results.results.length === 0) {
    return (
      <EmptyPanel
        title="Nothing matches today"
        // "Today", because a smart list's emptiness is relative: the same list may fill tomorrow
        // without anybody touching an item. "Nothing in here yet" would send somebody looking for
        // deleted items.
        detail="No item the filters match is visible to you right now. The list refills as items change."
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {results.truncated ? (
        <PartialNotice
          pending={`More items match than this list carries: the first ${String(results.results.length)} are shown.`}
        />
      ) : null}

      <ul className="flex flex-col">
        {results.results.map((row) => {
          const owner = { title: row.title ?? '', properties: row.properties };

          return (
            <li key={row.id} className="flex items-baseline gap-3 border-b border-divider py-2">
              <button
                type="button"
                onClick={() => {
                  onOpen(row.id);
                }}
                className={cn(
                  'cursor-pointer text-left font-semibold hover:text-accent-text',
                  focusRing,
                )}
              >
                {row.title ?? 'Untitled'}
              </button>

              {row.containerTitle === null ? null : (
                <Text variant="note" tone="muted" as="span">
                  in {row.containerTitle}
                </Text>
              )}

              {/* The values the query matched on, so a row says why it is here. The rule
                  properties are the view's own filters, deduplicated - a rule pair over one
                  property (Overdue's due/done) shows each key once. */}
              {[...new Set(view.filters.map((rule) => rule.property))].map((key) => {
                const text = readPropertyText(owner, key);
                return text.length === 0 ? null : (
                  <Text key={key} variant="note" tone="muted" as="span" className="ml-auto">
                    {text}
                  </Text>
                );
              })}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
