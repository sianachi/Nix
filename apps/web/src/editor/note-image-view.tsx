import { files as fileResources } from '@nix/api-client';
import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { useEffect, useState, type ReactNode } from 'react';
import { NoteImageSize } from './note-image-size';

import { useApiClient } from '../api/api-client-provider';
import { proseClasses } from './prose';
import { readOfflineNoteAsset, useOfflineNoteAssets } from '../offline/offline-assets';

/**
 * A note image backed by a Nix file item. The document stores the item identifier, never a
 * temporary object-store URL; every mounted view obtains its own authorized preview.
 */
export function NoteImageView(props: ReactNodeViewProps): ReactNode {
  const client = useApiClient();
  const local = useOfflineNoteAssets();
  const attrs = props.node.attrs as {
    readonly fileItemId?: unknown;
    readonly src?: unknown;
    readonly alt?: unknown;
    readonly width?: unknown;
  };
  const fileItemId =
    typeof attrs.fileItemId === 'string' && attrs.fileItemId.length > 0 ? attrs.fileItemId : null;
  const source = typeof attrs.src === 'string' ? attrs.src : '';
  const width =
    typeof attrs.width === 'number' && Number.isFinite(attrs.width) && attrs.width > 0
      ? attrs.width
      : undefined;
  const alt = typeof attrs.alt === 'string' ? attrs.alt : '';
  const [preview, setPreview] = useState<{
    readonly itemId: string;
    readonly url: string | null;
    readonly failed: boolean;
    readonly scope: string | undefined;
    readonly offline: boolean;
    readonly generation: number;
  } | null>(null);

  useEffect(() => {
    if (fileItemId === null) return;
    const controller = new AbortController();
    let url: string | null = null;
    const load = local.offline
      ? local.scope === undefined
        ? Promise.reject(new Error('This note has no offline image scope.'))
        : readOfflineNoteAsset(local.scope, fileItemId).then((blob) => {
            if (blob === null) throw new Error('This image has not been downloaded.');
            return blob;
          })
      : fileResources
          .fetchFileContent(client, fileItemId, undefined, true, controller.signal)
          .then(({ blob }) => blob);
    void load
      .then((blob) => {
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setPreview({
          itemId: fileItemId,
          url,
          failed: false,
          scope: local.scope,
          offline: local.offline,
          generation: local.generation,
        });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setPreview({
            itemId: fileItemId,
            url: null,
            failed: true,
            scope: local.scope,
            offline: local.offline,
            generation: local.generation,
          });
      });
    return () => {
      controller.abort();
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [client, fileItemId, local.offline, local.scope, local.generation]);

  const current =
    preview?.itemId === fileItemId &&
    preview.scope === local.scope &&
    preview.offline === local.offline &&
    preview.generation === local.generation
      ? preview
      : null;
  return (
    <NodeViewWrapper as="figure" contentEditable={false} className="m-0">
      {fileItemId === null && (!local.offline || source.startsWith('data:')) ? (
        <img src={source} alt={alt} width={width} className={proseClasses.image} />
      ) : null}
      {fileItemId === null && local.offline && !source.startsWith('data:') ? (
        <span className="text-muted" role="status">
          This external image is unavailable offline.
        </span>
      ) : null}
      {fileItemId !== null && current?.url !== null && current?.url !== undefined ? (
        <img src={current.url} alt={alt} width={width} className={proseClasses.image} />
      ) : null}
      {fileItemId !== null && current === null ? (
        <span className="text-muted" role="status">
          Loading image…
        </span>
      ) : null}
      {fileItemId !== null && current?.failed ? (
        <span className="text-muted" role="alert">
          {local.offline
            ? 'This image has not been downloaded for offline use.'
            : 'This image is unavailable.'}
        </span>
      ) : null}
      {props.editor.isEditable && props.selected ? (
        <NoteImageSize
          width={width}
          onChange={(next) => {
            props.updateAttributes({ width: next ?? null, height: null });
          }}
        />
      ) : null}
    </NodeViewWrapper>
  );
}
