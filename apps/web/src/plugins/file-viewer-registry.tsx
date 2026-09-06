import type { ComponentType } from 'react';

export interface FileViewerPluginInput {
  readonly fileName: string;
  readonly mediaType: string;
  readonly source: string;
}

export interface FileViewerPlugin {
  readonly id: string;
  readonly matches: (file: Pick<FileViewerPluginInput, 'fileName' | 'mediaType'>) => boolean;
  readonly Component: ComponentType<Pick<FileViewerPluginInput, 'fileName' | 'source'>>;
}

/** The host owns this registry so file viewers remain plugins rather than conditionals in FileViewer. */
export function createFileViewerRegistry(
  plugins: readonly FileViewerPlugin[],
): (file: Pick<FileViewerPluginInput, 'fileName' | 'mediaType'>) => FileViewerPlugin | null {
  return (file) => plugins.find((plugin) => plugin.matches(file)) ?? null;
}
