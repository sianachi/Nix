import type { ComponentType } from 'react';

export interface FileViewerPluginInput {
  readonly fileName: string;
  readonly mediaType: string;
  readonly source: string;
}

/**
 * What a viewer wants handed to it.
 *
 * `text` viewers receive the file's decoded text and draw it themselves. `url` viewers receive an
 * object URL for the authorised bytes, for the elements that can only take a URL - `<audio>`,
 * `<video>` - and for anything too large to hold as a string.
 */
export type FileViewerSourceKind = 'text' | 'url';

export interface FileViewerPlugin {
  readonly id: string;
  readonly matches: (file: Pick<FileViewerPluginInput, 'fileName' | 'mediaType'>) => boolean;
  /** Defaults to `text`. */
  readonly source?: FileViewerSourceKind;
  readonly Component: ComponentType<Pick<FileViewerPluginInput, 'fileName' | 'source'>>;
}

/** The host owns this registry so file viewers remain plugins rather than conditionals in FileViewer. */
export function createFileViewerRegistry(
  plugins: readonly FileViewerPlugin[],
): (file: Pick<FileViewerPluginInput, 'fileName' | 'mediaType'>) => FileViewerPlugin | null {
  return (file) => plugins.find((plugin) => plugin.matches(file)) ?? null;
}

/** The media type without its parameters, lower-cased: `text/plain; charset=utf-8` is `text/plain`. */
export function bareMediaType(mediaType: string): string {
  return mediaType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

/** The file's extension, lower-cased and without the dot, or an empty string. */
export function fileExtension(fileName: string): string {
  const match = /\.([^./\\]+)$/u.exec(fileName);
  return match?.[1]?.toLowerCase() ?? '';
}
