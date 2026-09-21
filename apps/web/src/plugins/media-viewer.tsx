import type { ReactElement } from 'react';

import { bareMediaType, fileExtension, type FileViewerPlugin } from './file-viewer-registry';

/**
 * Audio and video, played in place.
 *
 * A `url` viewer: the browser's own media elements take a URL and stream from it, and the object
 * URL the host makes from the authorised bytes is exactly that. Nothing here decodes anything.
 */

const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  'mp3',
  'wav',
  'ogg',
  'oga',
  'm4a',
  'flac',
  'aac',
]);
const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mov']);

export function mediaKind(fileName: string, mediaType: string): 'audio' | 'video' | null {
  const type = bareMediaType(mediaType);
  if (type.startsWith('audio/')) {
    return 'audio';
  }
  if (type.startsWith('video/')) {
    return 'video';
  }
  const extension = fileExtension(fileName);
  if (AUDIO_EXTENSIONS.has(extension)) {
    return 'audio';
  }
  if (VIDEO_EXTENSIONS.has(extension)) {
    return 'video';
  }
  return null;
}

export function MediaViewer({
  fileName,
  source,
}: {
  readonly fileName: string;
  readonly source: string;
}): ReactElement {
  const kind = mediaKind(fileName, '') ?? 'video';
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      {kind === 'audio' ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption -- an uploaded recording has no track to offer.
        <audio controls src={source} aria-label={fileName} className="w-full max-w-prose" />
      ) : (
        // eslint-disable-next-line jsx-a11y/media-has-caption -- an uploaded recording has no track to offer.
        <video
          controls
          src={source}
          aria-label={fileName}
          className="max-h-full max-w-full rounded-md"
        />
      )}
    </div>
  );
}

export const mediaViewerPlugin: FileViewerPlugin = {
  id: 'nix.media.viewer',
  matches: ({ fileName, mediaType }) => mediaKind(fileName, mediaType) !== null,
  source: 'url',
  Component: MediaViewer,
};
