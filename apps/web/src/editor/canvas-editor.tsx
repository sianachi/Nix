import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { useAuth } from '../auth/auth-provider';
import { useSessionStore } from '../auth/session-store';
import { createCanvasBinding, type CanvasElement } from './canvas-binding';
import { startCollabSync, type CollabSync, type SyncState } from './collab-sync';
import { PresenceList } from './presence-list';
import { SyncFooter } from './sync-footer';
import { NixCanvas } from './nix-canvas';
import type { NixCanvasElement } from './nix-canvas-model';

/**
 * The Nix canvas body over the same Yjs document, provider, and append-only log as a note.
 * The renderer owns interaction state; this component owns the document lifecycle and keeps
 * remote scene changes flowing into React while local commands go through the shared binding.
 */

export interface CanvasEditorProps {
  readonly itemId: string;
  readonly documentPath?: string | undefined;
  readonly onSync?: ((sync: CollabSync | null) => void) | undefined;
}

export function CanvasEditor({ itemId, documentPath, onSync }: CanvasEditorProps): ReactNode {
  const { getAccessToken } = useAuth();
  const profile = useSessionStore((state) => state.profile);
  const [syncState, setSyncState] = useState<SyncState>('connecting');
  const [elements, setElements] = useState<CanvasElement[]>([]);

  // One document per item, created exactly once via useState's lazy initializer - unlike
  // useMemo, which is only a performance hint React is free to discard and recompute,
  // useState's initial value truly runs once per mount - and destroyed with the component, so
  // switching canvases cannot carry one scene's elements into another.
  const [doc] = useState(() => new Y.Doc());
  const [awareness] = useState(() => new Awareness(doc));

  const bindingRef = useRef<ReturnType<typeof createCanvasBinding> | null>(null);

  useEffect(() => {
    const binding = createCanvasBinding(doc, setElements);
    bindingRef.current = binding;

    const sync = startCollabSync({
      itemId,
      documentPath,
      doc,
      awareness,
      fragmentName: 'elements',
      getAccessToken,
      onState: setSyncState,
    });
    onSync?.(sync);

    return () => {
      onSync?.(null);
      bindingRef.current = null;
      binding.destroy();
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

      <div className="min-h-0 flex-1" aria-label="Canvas body">
        <NixCanvas
          elements={elements as NixCanvasElement[]}
          onChange={(nextElements) => {
            setElements([...nextElements]);
            bindingRef.current?.applyLocal(nextElements);
          }}
        />
      </div>

      <SyncFooter state={syncState} />
    </div>
  );
}
