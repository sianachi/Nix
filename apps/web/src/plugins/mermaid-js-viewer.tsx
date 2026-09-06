import mermaid from 'mermaid';
import { useEffect, useId, useState, type ReactElement } from 'react';

import type { FileViewerPlugin } from './file-viewer-registry';

const MERMAID_MEDIA_TYPES = new Set([
  'application/vnd.mermaid',
  'text/mermaid',
  'text/vnd.mermaid',
  'text/x-mermaid',
]);

mermaid.initialize({ securityLevel: 'strict', startOnLoad: false, theme: 'base' });

export function isMermaidFile(fileName: string, mediaType: string): boolean {
  const normalizedMediaType = mediaType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return MERMAID_MEDIA_TYPES.has(normalizedMediaType) || /\.(?:mmd|mermaid)$/iu.test(fileName);
}

interface MermaidState {
  readonly svg: string | null;
  readonly error: string | null;
}

function MermaidViewer({
  fileName,
  source,
}: {
  readonly fileName: string;
  readonly source: string;
}): ReactElement {
  const generatedId = useId().replace(/:/gu, '');
  const [state, setState] = useState<MermaidState>({ svg: null, error: null });

  useEffect(() => {
    let active = true;
    void mermaid
      .render(`nix-mermaid-${generatedId}`, source)
      .then(({ svg }) => {
        if (active) setState({ svg, error: null });
      })
      .catch((reason: unknown) => {
        if (active) {
          setState({
            svg: null,
            error:
              reason instanceof Error ? reason.message : 'Mermaid could not render this diagram.',
          });
        }
      });
    return () => {
      active = false;
    };
  }, [generatedId, source]);

  return (
    <section aria-label={`Mermaid diagram from ${fileName}`} className="space-y-3">
      {state.svg === null ? (
        <div role={state.error === null ? 'status' : 'alert'} className="rounded-md bg-surface p-4">
          {state.error === null
            ? 'Rendering Mermaid diagram…'
            : `Mermaid could not render this diagram: ${state.error}`}
        </div>
      ) : (
        <div
          aria-label={`${fileName} diagram`}
          className="overflow-auto rounded-md bg-surface p-4"
          dangerouslySetInnerHTML={{ __html: state.svg }}
        />
      )}
      {state.error === null ? null : (
        <details>
          <summary>Show Mermaid source</summary>
          <pre className="mt-2 overflow-auto rounded-md bg-surface p-4 text-sm">{source}</pre>
        </details>
      )}
    </section>
  );
}

export const mermaidJsViewerPlugin: FileViewerPlugin = {
  id: 'nix.mermaid-js.viewer',
  matches: ({ fileName, mediaType }) => isMermaidFile(fileName, mediaType),
  Component: MermaidViewer,
};
