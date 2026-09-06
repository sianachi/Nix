import { createFileViewerRegistry } from './file-viewer-registry';
import { mermaidJsViewerPlugin } from './mermaid-js-viewer';

export const builtInFileViewerPlugins = [mermaidJsViewerPlugin] as const;

export const findBuiltInFileViewer = createFileViewerRegistry(builtInFileViewerPlugins);
