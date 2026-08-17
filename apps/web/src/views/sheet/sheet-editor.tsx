import { SHEET_CELLS_KEY } from '@nix/sheet';
import { Text } from '@nix/ui';
import { useEffect, useState, type ReactNode } from 'react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { useAuth } from '../../auth/auth-provider';
import { useSessionStore } from '../../auth/session-store';
import { startCollabSync, type CollabSync, type SyncState } from '../../editor/collab-sync';
import { PresenceList } from '../../editor/presence-list';
import { SyncFooter } from '../../editor/sync-footer';
import { SheetGrid } from './sheet-grid';
import { useSheet } from './use-sheet';

/**
 * The spreadsheet body: a cell grid over a Yjs document, synchronised through
 * the same collaboration service, transport and presence as the note and
 * canvas bodies - a body kind, not a second system.
 *
 * The document shape and the formula engine live in `@nix/sheet`, which the
 * collaboration service also imports: an update this editor produces is
 * validated by the same code that produced it, and the values a colleague
 * sees are computed by the same engine that computed yours. Unlike the
 * canvas, the grid needs no reconciliation binding - the shared `Y.Map` it
 * reads and writes through `useSheet` already is the state, the same way
 * `ySyncPlugin` makes the shared fragment the note's state.
 *
 * Keyed on the item by its caller, exactly as the other bodies are, so
 * switching items builds a fresh document rather than merging two.
 */

export interface SheetEditorProps {
  readonly itemId: string;
  readonly documentPath?: string | undefined;
  readonly onSync?: ((sync: CollabSync | null) => void) | undefined;
}

/**
 * What a refused update means for a person looking at a grid, for the codes
 * a sheet can actually reach today. Codes with no entry here (schema version
 * mismatches, unreadable payloads) are transport-level and already surface
 * through `SyncFooter`'s own states.
 */
const REFUSAL_COPY: Readonly<Record<string, string>> = {
  document_too_many_nodes:
    'This sheet has more cells than can be saved. Recent edits are not saved - remove some cells and they will send.',
  document_too_large:
    'This sheet is too large to save. Recent edits are not saved - remove some content and they will send.',
  document_does_not_parse:
    'This sheet cannot be saved as written - a cell holds something the sheet format cannot store, or a formula is too expensive to finish recalculating.',
};

export function SheetEditor({ itemId, documentPath, onSync }: SheetEditorProps): ReactNode {
  const { getAccessToken } = useAuth();
  const profile = useSessionStore((state) => state.profile);
  const [syncState, setSyncState] = useState<SyncState>('connecting');
  const [refusal, setRefusal] = useState<string | null>(null);

  // One document per item, created exactly once via useState's lazy initializer - unlike
  // useMemo, which is only a performance hint React is free to discard and recompute,
  // useState's initial value truly runs once per mount - and destroyed with the component, so
  // switching sheets cannot carry one sheet's cells into another.
  const [doc] = useState(() => new Y.Doc());
  const [awareness] = useState(() => new Awareness(doc));
  const sheet = useSheet(doc);

  useEffect(() => {
    const sync = startCollabSync({
      itemId,
      documentPath,
      doc,
      awareness,
      fragmentName: SHEET_CELLS_KEY,
      getAccessToken,
      onState: (state) => {
        // A fresh connection means whatever was refused before may not apply to what is
        // about to be resynced - the banner is for the last update, not a standing fact.
        if (state === 'live') {
          setRefusal(null);
        }
        setSyncState(state);
      },
      onNotice: (notice) => {
        const copy = REFUSAL_COPY[notice.code];
        if (copy !== undefined) {
          setRefusal(copy);
        }
      },
    });
    onSync?.(sync);
    return () => {
      onSync?.(null);
      sync.destroy();
    };
  }, [awareness, doc, documentPath, getAccessToken, itemId, onSync]);

  useEffect(() => {
    awareness.setLocalStateField('user', {
      name: profile?.name ?? 'Someone',
      color: 'var(--color-accent)',
    });
  }, [awareness, profile]);

  useEffect(() => {
    return () => {
      awareness.destroy();
      doc.destroy();
    };
  }, [awareness, doc]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-end px-8 py-1.5">
        <PresenceList awareness={awareness} />
      </div>

      {refusal === null ? null : (
        <Text variant="caption" as="p" role="alert" className="shrink-0 bg-background px-8 py-1.5">
          {refusal}
        </Text>
      )}

      {sheet.budget.exceeded ? (
        <Text variant="caption" as="p" role="alert" className="shrink-0 bg-background px-8 py-1.5">
          This sheet is too large to finish recalculating. Some cells show #LIMIT! until you remove
          formulas or ranges.
        </Text>
      ) : null}

      <SheetGrid sheet={sheet} />

      <SyncFooter state={syncState} />
    </div>
  );
}
