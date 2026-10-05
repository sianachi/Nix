import { MobileWorkspaceBrowser } from '../items/mobile-workspace-browser';
import { focusPane } from '../panes/pane-params';
import type { OpenItemControl } from '../tabs/use-open-item';
import type { StructuredRecipeId } from '../views/wizard/structured-recipes';
import type { TemplateLibraryStatus } from '../templates/use-templates';
import type { TemplateSummary } from '../templates/template-api';
import { SidebarDivider } from '../layout/sidebar-divider';
import { SidebarDrawer } from '../layout/sidebar-drawer';
import type { Sidebar } from '../layout/use-sidebar';
import { WorkspaceSidebar } from '../items/workspace-sidebar';
import type { TreeItem, WorkspaceTree } from '../items/use-workspace-tree';
import { useRef, useState, type ReactNode, type RefObject } from 'react';

export interface ShellSidebarProps {
  readonly narrow: boolean;
  readonly sidebar: Sidebar;
  readonly tree: WorkspaceTree;
  readonly selectedId: string | null;
  readonly openItem: Pick<
    OpenItemControl,
    'openPreview' | 'openPinned' | 'openBeside' | 'canOpenBeside' | 'besideRefusal'
  >;
  readonly onDeleteItem: (item: TreeItem) => void;
  readonly onStartStructured: (parentId: string | null, recipe: StructuredRecipeId) => void;
  readonly templates: readonly TemplateSummary[];
  readonly templateStatus: TemplateLibraryStatus;
  readonly onStartTemplate: (parentId: string | null, templateId: string) => void;
  readonly onBrowseTemplates: (parentId: string | null) => void;
  readonly onRecord: (() => void) | undefined;
  readonly treeRegionRef: RefObject<HTMLDivElement | null>;
  readonly sidebarToggleRef: RefObject<HTMLButtonElement | null>;
}

/**
 * Presents the workspace tree in its two shell-owned arrangements: fixed beside the pane or
 * temporarily in a narrow-screen drawer.
 */
export function ShellSidebar({
  narrow,
  sidebar,
  tree,
  selectedId,
  openItem,
  onDeleteItem,
  onStartStructured,
  templates,
  templateStatus,
  onStartTemplate,
  onBrowseTemplates,
  onRecord,
  treeRegionRef,
  sidebarToggleRef,
}: ShellSidebarProps): ReactNode {
  const [browseParent, setBrowseParent] = useState<string | null>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);

  function closeDrawerAfter<Args extends readonly string[]>(
    action: (...args: Args) => void,
  ): (...args: Args) => void {
    return (...args: Args) => {
      action(...args);
      if (narrow) {
        sidebar.toggle();
        // `focusPane` defers until the pane has rendered and the drawer has removed `inert` from
        // `<main>`, so the focus call is not silently ignored.
        focusPane(0);
      }
    };
  }

  function closeDrawer(): void {
    sidebar.toggle();
    sidebarToggleRef.current?.focus();
  }

  const workspaceTree = (
    <WorkspaceSidebar
      tree={tree}
      selectedId={selectedId}
      onSelect={openItem.openPreview}
      onOpenBeside={openItem.openBeside}
      onOpenPinned={openItem.openPinned}
      canOpenBeside={openItem.canOpenBeside}
      besideRefusal={openItem.besideRefusal}
      onDeleteItem={onDeleteItem}
      onStartStructured={onStartStructured}
      templates={templates}
      templateStatus={templateStatus}
      onStartTemplate={onStartTemplate}
      onBrowseTemplates={onBrowseTemplates}
      onRecord={onRecord === undefined ? undefined : closeDrawerAfter(onRecord)}
      treeRegionRef={treeRegionRef}
    />
  );

  return (
    <>
      {!sidebar.visible ? null : narrow ? (
        <SidebarDrawer onClose={closeDrawer}>
          {/* Browse and open only. The full tree's actions - structured items, templates, delete,
              open beside - are laid out for a pointer and a wide pane, and are not offered on a
              phone. */}
          <MobileWorkspaceBrowser
            tree={tree}
            parentId={browseParent}
            onParent={setBrowseParent}
            onOpen={closeDrawerAfter(openItem.openPreview)}
          />
        </SidebarDrawer>
      ) : (
        <>
          <div
            ref={sidebarRef}
            style={{ width: `${String(sidebar.width)}px` }} // design-token-exempt: runtime drag width.
            className="flex shrink-0 overflow-hidden"
          >
            {workspaceTree}
          </div>

          <SidebarDivider
            width={sidebar.width}
            onPreview={(width) => {
              sidebarRef.current?.style.setProperty('width', `${String(width)}px`);
            }}
            onCommit={sidebar.resize}
          />
        </>
      )}
    </>
  );
}
