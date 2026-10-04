import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { useNavigate, useParams } from 'react-router';

import { useAuth } from '../auth/auth-provider';
import { useSessionStore } from '../auth/session-store';
import { createCanvasBinding, type CanvasElement } from './canvas-binding';
import { documentScope } from './body-cache';
import { startCollabSync, type CollabSync, type SyncState } from './collab-sync';
import { sceneFingerprint } from './nix-canvas-model';
import { PresenceList } from './presence-list';
import { SyncFooter } from './sync-footer';
import { Button, Text } from '@nix/ui';
import { CanvasBrowser } from './canvas-browser';
import { useNarrowViewport } from '../layout/viewport';
import { useItemDialog } from '../items/item-dialog-context';
import { LOCAL_COPY_STALE, StaleCopyNotice } from './stale-copy-notice';
const NixCanvas = lazy(async () => {
  const module = await import('./nix-canvas');
  return { default: module.NixCanvas };
});

/**
 * The Nix canvas body over the same Yjs document, provider, and append-only log as a note.
 * The renderer owns interaction state; this component owns the document lifecycle and keeps
 * remote scene changes flowing into React while local commands go through the shared binding.
 */

export interface CanvasEditorProps {
  readonly itemId: string;
  readonly documentPath?: string | undefined;
  readonly onSync?: ((sync: CollabSync | null) => void) | undefined;
  /**
   * Keep a local copy of this body so reopening it paints at once (see `body-cache.ts`). Off
   * unless the page says so: only a page that has read the item's lock state knows the body
   * carries no lock, and a locked body is never kept on disk.
   */
  readonly cacheBody?: boolean;
  /** The item's own controls - details and actions - when they live in this bar on a phone. */
  readonly itemControls?: ReactNode;
}

/** A document identity change must replace the Y.Doc, not reconnect a new item to the old scene. */
export function CanvasEditor(props: CanvasEditorProps): ReactNode {
  return <CanvasEditorSession key={props.documentPath ?? props.itemId} {...props} />;
}

function CanvasEditorSession({
  itemId,
  documentPath,
  onSync,
  cacheBody = false,
  itemControls,
}: CanvasEditorProps): ReactNode {
  const { getAccessToken } = useAuth();
  const profile = useSessionStore((state) => state.profile);
  const navigate = useNavigate();
  const openDialog = useItemDialog();
  const narrow = useNarrowViewport();
  const [spatial, setSpatial] = useState(false);
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const [syncState, setSyncState] = useState<SyncState>('connecting');
  const [elements, setElements] = useState<CanvasElement[]>([]);
  // The painted local copy turned out to be another version's; see `StaleCopyNotice`.
  const [stale, setStale] = useState(false);
  const [localCopy, setLocalCopy] = useState(false);

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
      onLocalCopy: () => {
        setLocalCopy(true);
      },
      cacheScope: cacheBody
        ? documentScope(profile?.subject, workspaceId, itemId, documentPath ?? 'canvas')
        : undefined,
      doc,
      awareness,
      fragmentName: 'elements',
      getAccessToken,
      onState: setSyncState,
      onNotice: (notice) => {
        if (notice.code === LOCAL_COPY_STALE) setStale(true);
      },
    });
    onSync?.(sync);

    return () => {
      onSync?.(null);
      bindingRef.current = null;
      binding.destroy();
      sync.destroy();
    };
  }, [
    awareness,
    doc,
    documentPath,
    getAccessToken,
    itemId,
    onSync,
    profile?.subject,
    workspaceId,
    cacheBody,
  ]);

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

  function openItem(targetItemId: string): void {
    if (openDialog) openDialog(targetItemId);
    else if (workspaceId !== undefined)
      void navigate(`/w/${workspaceId}?item=${encodeURIComponent(targetItemId)}`);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-end gap-1 px-8 py-1.5">
        <PresenceList awareness={awareness} />
        {itemControls}
      </div>

      {narrow ? (
        <div className="flex shrink-0 gap-2 px-4 py-2" aria-label="Canvas presentation">
          <Button
            variant="ghost"
            aria-pressed={!spatial}
            onClick={() => {
              setSpatial(false);
            }}
          >
            Contents
          </Button>
          <Button
            variant="ghost"
            aria-pressed={spatial}
            onClick={() => {
              setSpatial(true);
            }}
          >
            Spatial canvas
          </Button>
        </div>
      ) : null}
      {stale ? <StaleCopyNotice noun="canvas" /> : null}
      <div className="min-h-0 flex-1" aria-label="Canvas body">
        {narrow && !spatial ? (
          <CanvasBrowser
            elements={elements}
            onOpen={openItem}
            onSpatial={() => {
              setSpatial(true);
            }}
            loading={syncState === 'connecting'}
          />
        ) : (
          <Suspense fallback={<Text as="p">Loading spatial canvas…</Text>}>
            <NixCanvas
              elements={elements}
              workspaceId={workspaceId}
              parentItemId={itemId}
              awareness={awareness}
              readOnly={syncState === 'readonly' || stale}
              allowFileUploads={documentPath === undefined}
              onChange={(nextElements) => {
                const binding = bindingRef.current;
                if (binding === null) {
                  setElements((current) =>
                    sceneFingerprint(current) === sceneFingerprint(nextElements)
                      ? current
                      : [...nextElements],
                  );
                  return;
                }
                binding.applyLocal(nextElements);
                // The map may already hold a newer remote version. Render the accepted merged scene,
                // never an optimistic local array that the binding just rejected.
                const snapshot = binding.snapshot();
                setElements((current) =>
                  sceneFingerprint(current) === sceneFingerprint(snapshot) ? current : snapshot,
                );
              }}
              onOpenItem={openItem}
            />
          </Suspense>
        )}
      </div>

      <SyncFooter showingLocalCopy={localCopy} state={syncState} />
    </div>
  );
}
