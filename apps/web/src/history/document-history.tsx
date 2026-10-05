import { useEffect, useState, type ReactNode } from 'react';

import { HistorySidebar } from './history-sidebar';
import { useDocumentHistory } from './use-document-history';

/**
 * The history panel for one item: the hook wired to the sidebar.
 *
 * The sidebar is a pure component and the hook is a pure data source, built by different hands
 * against the same plan; this is the seam where their two vocabularies meet. Two translations
 * live here and nowhere else: a refusal becomes the sentence the sidebar shows, and the hook's
 * result type is unwrapped for the sidebar's `stateAt`, which wants a state or nothing.
 *
 * **The live document comes from the log, not from the editor.** The diff is measured against
 * the state at the head sequence, fetched like any other revision, rather than against the
 * editor instance on the page. That keeps this panel usable beside any body kind and beside no
 * editor at all, and it means the "current" side of the diff is what the server has, which is
 * what a restore would be measured against too.
 */
export function DocumentHistory({
  itemId,
  onClose,
}: {
  readonly itemId: string;
  readonly onClose: () => void;
}): ReactNode {
  const history = useDocumentHistory(itemId);
  const [current, setCurrent] = useState<{
    readonly seq: number;
    readonly document: unknown;
  } | null>(null);
  const [actionRefusal, setActionRefusal] = useState<string | null>(null);

  const { headSeq, stateAt } = history;
  useEffect(() => {
    if (headSeq === null || current?.seq === headSeq) {
      return;
    }
    let cancelled = false;
    void stateAt(headSeq).then((result) => {
      if (cancelled) return;
      if (result.ok && result.value !== null) {
        setCurrent({ seq: headSeq, document: result.value.document });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [headSeq, stateAt, current?.seq]);

  const refusal = actionRefusal ?? history.refusal?.detail ?? null;

  return (
    <HistorySidebar
      revisions={history.revisions}
      hasMore={history.hasMore}
      loadMore={() => {
        void history.loadMore();
      }}
      namedVersions={history.namedVersions}
      headSeq={history.headSeq}
      loading={history.loading}
      refusal={refusal}
      currentDocument={current?.document ?? null}
      stateAt={async (seq) => {
        const result = await history.stateAt(seq);
        if (!result.ok) {
          setActionRefusal(result.refusal.detail);
          return null;
        }
        return result.value;
      }}
      onRestore={(seq) => {
        setActionRefusal(null);
        void history.restore(seq).then((result) => {
          if (!result.ok) setActionRefusal(result.refusal.detail);
        });
      }}
      onName={(seq, name) => {
        setActionRefusal(null);
        void history.nameVersion(seq, name).then((result) => {
          if (!result.ok) setActionRefusal(result.refusal.detail);
        });
      }}
      onRemoveName={(seq) => {
        setActionRefusal(null);
        void history.removeName(seq).then((result) => {
          if (!result.ok) setActionRefusal(result.refusal.detail);
        });
      }}
      onClose={onClose}
    />
  );
}
