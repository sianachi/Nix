import { Excalidraw } from '@excalidraw/excalidraw';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { useAuth } from '../auth/auth-provider';
import { useSessionStore } from '../auth/session-store';
import { createCanvasBinding, type CanvasElement } from './canvas-binding';
import { startCollabSync, type SyncState } from './collab-sync';
import { PresenceList } from './presence-list';
import { SyncFooter } from './sync-footer';

// Excalidraw ships its own stylesheet for the drawing chrome it renders. Importing a
// third-party component's own styles is the same boundary as TipTap rendering prose
// outside React: the library owns its internals, the tokens own everything of ours. This
// whole module is loaded lazily at the page seam, so neither the library nor its styles
// reach the bundle a note-only user pays for.
import '@excalidraw/excalidraw/index.css';

/**
 * The canvas body: an Excalidraw scene over the same Yjs document, the same provider and
 * the same append-only log as a note - a body kind, not a second system.
 *
 * Excalidraw keeps its own scene state and mutates it in place, so the collaboration is a
 * conversation rather than a binding: local changes flow out through `onChange` as
 * whole-element writes the binding reconciles by version, and remote changes come back by
 * replacing the rendered scene. Undo stays Excalidraw's own, which is inherently local -
 * undoing bumps the element's version, so it propagates as an ordinary edit and never
 * touches a colleague's work.
 */

export interface CanvasEditorProps {
  readonly itemId: string;
}

/** The slice of Excalidraw's imperative API this editor needs. */
interface SceneApi {
  updateScene(scene: { elements: readonly CanvasElement[] }): void;
}

export function CanvasEditor({ itemId }: CanvasEditorProps): ReactNode {
  const { getAccessToken } = useAuth();
  const profile = useSessionStore((state) => state.profile);
  const [syncState, setSyncState] = useState<SyncState>('connecting');

  // One document per item, created exactly once via useState's lazy initializer - unlike
  // useMemo, which is only a performance hint React is free to discard and recompute,
  // useState's initial value truly runs once per mount - and destroyed with the component, so
  // switching canvases cannot carry one scene's elements into another.
  const [doc] = useState(() => new Y.Doc());
  const [awareness] = useState(() => new Awareness(doc));

  const apiRef = useRef<SceneApi | null>(null);
  const bindingRef = useRef<ReturnType<typeof createCanvasBinding> | null>(null);

  useEffect(() => {
    const binding = createCanvasBinding(doc, (elements) => {
      apiRef.current?.updateScene({ elements });
    });
    bindingRef.current = binding;

    const sync = startCollabSync({
      itemId,
      doc,
      awareness,
      fragmentName: 'elements',
      getAccessToken,
      onState: setSyncState,
    });

    return () => {
      bindingRef.current = null;
      binding.destroy();
      sync.destroy();
    };
  }, [awareness, doc, getAccessToken, itemId]);

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
        <Excalidraw
          excalidrawAPI={(api) => {
            apiRef.current = api as unknown as SceneApi;
            // The shared scene is the source of truth; whatever the server already
            // holds replaces the empty scene Excalidraw booted with.
            const scene = bindingRef.current?.snapshot() ?? [];
            if (scene.length > 0) {
              (api as unknown as SceneApi).updateScene({ elements: scene });
            }
          }}
          onChange={(elements) => {
            bindingRef.current?.applyLocal(elements);
          }}
        />
      </div>

      <SyncFooter state={syncState} />
    </div>
  );
}
