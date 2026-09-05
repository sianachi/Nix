import { Button, Text } from '@nix/ui';
import type { ReactElement, ReactNode } from 'react';

import {
  EmptyPanel,
  ErrorPanel,
  LoadingPanel,
  PartialNotice,
} from '../components/states/status-panels';
import { GraphExplorer } from '../graph/graph-explorer';
import { useItemDialog } from '../items/item-dialog-context';
import { useWorkspaceGraph } from '../graph/use-workspace-graph';
import { paneScroller } from '../layout/regions';
import { useOpenItem } from '../tabs/use-open-item';

/**
 * The graph destination: the workspace as items and the references between them.
 *
 * **The truncation notice is the part that is not decoration.** Core bounds the response at 2,000
 * nodes and 4,000 links and reports whether it hit either ceiling. A truncated list looks short and
 * announces itself; a truncated graph looks like a graph. A reader shown 2,000 of 3,000 items would
 * conclude two clusters are unconnected, which is a wrong answer rather than a missing one - so
 * whenever a flag is set this page says so above the drawing, and says which ceiling was hit.
 *
 * Opening a node presents the full item in a dialog while the graph stays mounted. Only the
 * explicit Open as page action changes the workspace destination.
 */
/**
 * The destination's frame: its heading, and whatever state it is in.
 *
 * The heading is outside the state fork on purpose. It is the answer to "where am I", which is
 * true while the graph is loading, true when it failed, and true when the workspace is empty - and
 * a destination that only names itself once it has data leaves a reader on an untitled page in
 * exactly the moments they most need to know where they landed.
 */
function GraphFrame({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <div className={`${paneScroller} flex flex-col gap-4 p-4`}>
      <Text variant="h2" as="h1">
        Graph
      </Text>
      {children}
    </div>
  );
}

export function GraphPage(): ReactElement {
  const { status, graph, error, reload } = useWorkspaceGraph();
  const { openPreview } = useOpenItem();
  const openDialog = useItemDialog();

  if (status === 'loading') {
    return (
      <GraphFrame>
        <LoadingPanel label="the workspace graph" />
      </GraphFrame>
    );
  }

  if (status === 'error' || graph === null) {
    return (
      <GraphFrame>
        <ErrorPanel
          title="The graph could not be loaded"
          detail={error ?? 'Something went wrong reading this workspace.'}
          action={
            <Button
              onClick={() => {
                void reload();
              }}
            >
              Try again
            </Button>
          }
        />
      </GraphFrame>
    );
  }

  if (graph.nodes.length === 0) {
    return (
      <GraphFrame>
        <EmptyPanel
          title="Nothing to graph yet"
          detail="This workspace has no items you can read. Create a note, and it will appear here with anything it links to."
        />
      </GraphFrame>
    );
  }

  return (
    <GraphFrame>
      {graph.nodesTruncated && (
        <PartialNotice
          pending={`Showing the first ${String(graph.nodeLimit)} items in this workspace. Some items, and any references to them, are not drawn.`}
        />
      )}
      {graph.linksTruncated && (
        <PartialNotice
          pending={`Showing the first ${String(graph.linkLimit)} references. Some connections between the items below are not drawn.`}
        />
      )}

      <GraphExplorer nodes={graph.nodes} links={graph.links} onOpen={openDialog ?? openPreview} />
    </GraphFrame>
  );
}
